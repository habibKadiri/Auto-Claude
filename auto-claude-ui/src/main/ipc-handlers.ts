import { ipcMain, dialog, BrowserWindow, app } from 'electron';
import path from 'path';
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { spawn } from 'child_process';
import { IPC_CHANNELS, DEFAULT_APP_SETTINGS, AUTO_BUILD_PATHS } from '../shared/constants';
import type {
  Project,
  ProjectSettings,
  Task,
  AppSettings,
  IPCResult,
  TaskStartOptions,
  ImplementationPlan,
  TerminalCreateOptions,
  AutoBuildVersionInfo,
  InitializationResult,
  Roadmap,
  RoadmapFeature,
  RoadmapFeatureStatus,
  RoadmapGenerationStatus,
  ProjectIndex,
  ProjectContextData,
  GraphitiMemoryStatus,
  GraphitiMemoryState,
  MemoryEpisode,
  ContextSearchResult,
  ProjectEnvConfig,
  ClaudeAuthResult,
  LinearIssue,
  LinearTeam,
  LinearProject,
  LinearImportResult,
  LinearSyncStatus,
  GitHubRepository,
  GitHubIssue,
  GitHubSyncStatus,
  GitHubImportResult,
  GitHubInvestigationResult,
  GitHubInvestigationStatus,
  IdeationSession,
  IdeationConfig,
  IdeationGenerationStatus,
  IdeationStatus,
  SourceEnvConfig,
  SourceEnvCheckResult
} from '../shared/types';
import { projectStore } from './project-store';
import { fileWatcher } from './file-watcher';
import { AgentManager } from './agent-manager';
import { TerminalManager } from './terminal-manager';
import {
  initializeProject,
  updateProject,
  checkVersion,
  hasCustomEnv,
  getAutoBuildPath
} from './project-initializer';
import {
  checkForUpdates as checkSourceUpdates,
  downloadAndApplyUpdate,
  getBundledVersion,
  getEffectiveSourcePath
} from './auto-claude-updater';
import { changelogService } from './changelog-service';
import type { AutoBuildSourceUpdateProgress } from '../shared/types';

/**
 * Setup all IPC handlers
 */
export function setupIpcHandlers(
  agentManager: AgentManager,
  terminalManager: TerminalManager,
  getMainWindow: () => BrowserWindow | null
): void {
  // ============================================
  // Project Operations
  // ============================================

  ipcMain.handle(
    IPC_CHANNELS.PROJECT_ADD,
    async (_, projectPath: string): Promise<IPCResult<Project>> => {
      try {
        // Validate path exists
        if (!existsSync(projectPath)) {
          return { success: false, error: 'Directory does not exist' };
        }

        const project = projectStore.addProject(projectPath);
        return { success: true, data: project };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.PROJECT_REMOVE,
    async (_, projectId: string): Promise<IPCResult> => {
      const success = projectStore.removeProject(projectId);
      return { success };
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.PROJECT_LIST,
    async (): Promise<IPCResult<Project[]>> => {
      const projects = projectStore.getProjects();
      return { success: true, data: projects };
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.PROJECT_UPDATE_SETTINGS,
    async (
      _,
      projectId: string,
      settings: Partial<ProjectSettings>
    ): Promise<IPCResult> => {
      const project = projectStore.updateProjectSettings(projectId, settings);
      if (project) {
        return { success: true };
      }
      return { success: false, error: 'Project not found' };
    }
  );

  // ============================================
  // Project Initialization Operations
  // ============================================

  const settingsPath = path.join(app.getPath('userData'), 'settings.json');

  /**
   * Auto-detect the auto-claude source path relative to the app location
   * In dev: auto-claude-ui/../auto-claude
   * In prod: Could be bundled or configured
   */
  const detectAutoBuildSourcePath = (): string | null => {
    // Try relative to app directory (works in dev and if repo structure is maintained)
    // __dirname in main process points to out/main in dev
    const possiblePaths = [
      // Dev mode: from out/main -> ../../../auto-claude (sibling to auto-claude-ui)
      path.resolve(__dirname, '..', '..', '..', 'auto-claude'),
      // Alternative: from app root (useful in some packaged scenarios)
      path.resolve(app.getAppPath(), '..', 'auto-claude'),
      // If running from repo root
      path.resolve(process.cwd(), 'auto-claude'),
      // Try one more level up (in case of different build output structure)
      path.resolve(__dirname, '..', '..', 'auto-claude')
    ];

    console.log('[Auto-Claude] Detecting source path, checking:', possiblePaths);

    for (const p of possiblePaths) {
      if (existsSync(p) && existsSync(path.join(p, 'VERSION'))) {
        console.log('[Auto-Claude] Found source at:', p);
        return p;
      }
    }
    console.log('[Auto-Claude] No source path found');
    return null;
  };

  /**
   * Get the configured auto-claude source path from settings, or auto-detect
   */
  const getAutoBuildSourcePath = (): string | null => {
    // First check if manually configured
    if (existsSync(settingsPath)) {
      try {
        const content = readFileSync(settingsPath, 'utf-8');
        const settings = JSON.parse(content);
        if (settings.autoBuildPath && existsSync(settings.autoBuildPath)) {
          return settings.autoBuildPath;
        }
      } catch {
        // Fall through to auto-detect
      }
    }

    // Auto-detect from app location
    return detectAutoBuildSourcePath();
  };

  ipcMain.handle(
    IPC_CHANNELS.PROJECT_INITIALIZE,
    async (_, projectId: string): Promise<IPCResult<InitializationResult>> => {
      try {
        const project = projectStore.getProject(projectId);
        if (!project) {
          return { success: false, error: 'Project not found' };
        }

        const sourcePath = getAutoBuildSourcePath();
        if (!sourcePath) {
          return {
            success: false,
            error: 'Auto-build source path not configured. Please set it in App Settings.'
          };
        }

        const result = initializeProject(project.path, sourcePath);

        if (result.success) {
          // Update project's autoBuildPath
          projectStore.updateAutoBuildPath(projectId, '.auto-claude');
        }

        return { success: result.success, data: result, error: result.error };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.PROJECT_UPDATE_AUTOBUILD,
    async (_, projectId: string): Promise<IPCResult<InitializationResult>> => {
      try {
        const project = projectStore.getProject(projectId);
        if (!project) {
          return { success: false, error: 'Project not found' };
        }

        const sourcePath = getAutoBuildSourcePath();
        if (!sourcePath) {
          return {
            success: false,
            error: 'Auto-build source path not configured. Please set it in App Settings.'
          };
        }

        const result = updateProject(project.path, sourcePath);

        if (result.success) {
          // Refresh autoBuildPath in case it changed
          const newPath = getAutoBuildPath(project.path);
          if (newPath) {
            projectStore.updateAutoBuildPath(projectId, newPath);
          }
        }

        return { success: result.success, data: result, error: result.error };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.PROJECT_CHECK_VERSION,
    async (_, projectId: string): Promise<IPCResult<AutoBuildVersionInfo>> => {
      try {
        const project = projectStore.getProject(projectId);
        if (!project) {
          return { success: false, error: 'Project not found' };
        }

        const sourcePath = getAutoBuildSourcePath();
        if (!sourcePath) {
          // Return basic info without update check if no source configured
          const autoBuildPath = getAutoBuildPath(project.path);
          return {
            success: true,
            data: {
              isInitialized: !!autoBuildPath,
              updateAvailable: false
            }
          };
        }

        const versionInfo = checkVersion(project.path, sourcePath);

        // Add custom env check if initialized
        if (versionInfo.isInitialized && project.autoBuildPath) {
          const autoBuildFullPath = path.join(project.path, project.autoBuildPath);
          (versionInfo as AutoBuildVersionInfo).hasCustomEnv = hasCustomEnv(autoBuildFullPath);
        }

        return { success: true, data: versionInfo as AutoBuildVersionInfo };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        };
      }
    }
  );

  // ============================================
  // Task Operations
  // ============================================

  ipcMain.handle(
    IPC_CHANNELS.TASK_LIST,
    async (_, projectId: string): Promise<IPCResult<Task[]>> => {
      const tasks = projectStore.getTasks(projectId);
      return { success: true, data: tasks };
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.TASK_CREATE,
    async (
      _,
      projectId: string,
      title: string,
      description: string
    ): Promise<IPCResult<Task>> => {
      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }

      // Generate a unique task ID for tracking
      const taskId = `task-${Date.now()}`;

      // Start spec creation via agent manager
      agentManager.startSpecCreation(taskId, project.path, description);

      // Create a placeholder task
      const task: Task = {
        id: taskId,
        specId: '', // Will be assigned after spec creation
        projectId,
        title,
        description,
        status: 'backlog',
        chunks: [],
        logs: [],
        createdAt: new Date(),
        updatedAt: new Date()
      };

      return { success: true, data: task };
    }
  );

  ipcMain.on(
    IPC_CHANNELS.TASK_START,
    (_, taskId: string, options?: TaskStartOptions) => {
      const mainWindow = getMainWindow();
      if (!mainWindow) return;

      // Find task and project
      const projects = projectStore.getProjects();
      let task: Task | undefined;
      let project: Project | undefined;

      for (const p of projects) {
        const tasks = projectStore.getTasks(p.id);
        task = tasks.find((t) => t.id === taskId || t.specId === taskId);
        if (task) {
          project = p;
          break;
        }
      }

      if (!task || !project) {
        mainWindow.webContents.send(
          IPC_CHANNELS.TASK_ERROR,
          taskId,
          'Task or project not found'
        );
        return;
      }

      // Start file watcher for this task
      const specDir = path.join(
        project.path,
        AUTO_BUILD_PATHS.SPECS_DIR,
        task.specId
      );
      fileWatcher.watch(taskId, specDir);

      // Start task execution
      agentManager.startTaskExecution(
        taskId,
        project.path,
        task.specId,
        {
          parallel: options?.parallel ?? project.settings.parallelEnabled,
          workers: options?.workers ?? project.settings.maxWorkers
        }
      );

      // Notify status change
      mainWindow.webContents.send(
        IPC_CHANNELS.TASK_STATUS_CHANGE,
        taskId,
        'in_progress'
      );
    }
  );

  ipcMain.on(IPC_CHANNELS.TASK_STOP, (_, taskId: string) => {
    agentManager.killTask(taskId);
    fileWatcher.unwatch(taskId);

    const mainWindow = getMainWindow();
    if (mainWindow) {
      mainWindow.webContents.send(
        IPC_CHANNELS.TASK_STATUS_CHANGE,
        taskId,
        'backlog'
      );
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.TASK_REVIEW,
    async (
      _,
      taskId: string,
      approved: boolean,
      feedback?: string
    ): Promise<IPCResult> => {
      // Find task and project
      const projects = projectStore.getProjects();
      let task: Task | undefined;
      let project: Project | undefined;

      for (const p of projects) {
        const tasks = projectStore.getTasks(p.id);
        task = tasks.find((t) => t.id === taskId || t.specId === taskId);
        if (task) {
          project = p;
          break;
        }
      }

      if (!task || !project) {
        return { success: false, error: 'Task not found' };
      }

      const specDir = path.join(
        project.path,
        AUTO_BUILD_PATHS.SPECS_DIR,
        task.specId
      );

      if (approved) {
        // Write approval to QA report
        const qaReportPath = path.join(specDir, AUTO_BUILD_PATHS.QA_REPORT);
        writeFileSync(
          qaReportPath,
          `# QA Review\n\nStatus: APPROVED\n\nReviewed at: ${new Date().toISOString()}\n`
        );

        const mainWindow = getMainWindow();
        if (mainWindow) {
          mainWindow.webContents.send(
            IPC_CHANNELS.TASK_STATUS_CHANGE,
            taskId,
            'done'
          );
        }
      } else {
        // Write feedback for QA fixer
        const fixRequestPath = path.join(specDir, 'QA_FIX_REQUEST.md');
        writeFileSync(
          fixRequestPath,
          `# QA Fix Request\n\nStatus: REJECTED\n\n## Feedback\n\n${feedback || 'No feedback provided'}\n\nCreated at: ${new Date().toISOString()}\n`
        );

        // Restart QA process
        agentManager.startQAProcess(taskId, project.path, task.specId);

        const mainWindow = getMainWindow();
        if (mainWindow) {
          mainWindow.webContents.send(
            IPC_CHANNELS.TASK_STATUS_CHANGE,
            taskId,
            'in_progress'
          );
        }
      }

      return { success: true };
    }
  );

  // ============================================
  // Settings Operations
  // ============================================

  ipcMain.handle(
    IPC_CHANNELS.SETTINGS_GET,
    async (): Promise<IPCResult<AppSettings>> => {
      let settings = { ...DEFAULT_APP_SETTINGS };

      if (existsSync(settingsPath)) {
        try {
          const content = readFileSync(settingsPath, 'utf-8');
          settings = { ...settings, ...JSON.parse(content) };
        } catch {
          // Use defaults
        }
      }

      // If no manual autoBuildPath is set, try to auto-detect
      if (!settings.autoBuildPath) {
        const detectedPath = detectAutoBuildSourcePath();
        if (detectedPath) {
          settings.autoBuildPath = detectedPath;
        }
      }

      return { success: true, data: settings as AppSettings };
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.SETTINGS_SAVE,
    async (_, settings: Partial<AppSettings>): Promise<IPCResult> => {
      try {
        let currentSettings = DEFAULT_APP_SETTINGS;
        if (existsSync(settingsPath)) {
          const content = readFileSync(settingsPath, 'utf-8');
          currentSettings = { ...currentSettings, ...JSON.parse(content) };
        }

        const newSettings = { ...currentSettings, ...settings };
        writeFileSync(settingsPath, JSON.stringify(newSettings, null, 2));

        // Apply Python path if changed
        if (settings.pythonPath || settings.autoBuildPath) {
          agentManager.configure(settings.pythonPath, settings.autoBuildPath);
        }

        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to save settings'
        };
      }
    }
  );

  // ============================================
  // Dialog Operations
  // ============================================

  ipcMain.handle(
    IPC_CHANNELS.DIALOG_SELECT_DIRECTORY,
    async (): Promise<string | null> => {
      const mainWindow = getMainWindow();
      if (!mainWindow) return null;

      const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory'],
        title: 'Select Project Directory'
      });

      if (result.canceled || result.filePaths.length === 0) {
        return null;
      }

      return result.filePaths[0];
    }
  );

  // ============================================
  // App Info
  // ============================================

  ipcMain.handle(IPC_CHANNELS.APP_VERSION, async (): Promise<string> => {
    return app.getVersion();
  });

  // ============================================
  // Terminal Operations
  // ============================================

  ipcMain.handle(
    IPC_CHANNELS.TERMINAL_CREATE,
    async (_, options: TerminalCreateOptions): Promise<IPCResult> => {
      return terminalManager.create(options);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.TERMINAL_DESTROY,
    async (_, id: string): Promise<IPCResult> => {
      return terminalManager.destroy(id);
    }
  );

  ipcMain.on(
    IPC_CHANNELS.TERMINAL_INPUT,
    (_, id: string, data: string) => {
      terminalManager.write(id, data);
    }
  );

  ipcMain.on(
    IPC_CHANNELS.TERMINAL_RESIZE,
    (_, id: string, cols: number, rows: number) => {
      terminalManager.resize(id, cols, rows);
    }
  );

  ipcMain.on(
    IPC_CHANNELS.TERMINAL_INVOKE_CLAUDE,
    (_, id: string, cwd?: string) => {
      terminalManager.invokeClaude(id, cwd);
    }
  );

  // ============================================
  // Agent Manager Events → Renderer
  // ============================================

  agentManager.on('log', (taskId: string, log: string) => {
    const mainWindow = getMainWindow();
    if (mainWindow) {
      mainWindow.webContents.send(IPC_CHANNELS.TASK_LOG, taskId, log);
    }
  });

  agentManager.on('error', (taskId: string, error: string) => {
    const mainWindow = getMainWindow();
    if (mainWindow) {
      mainWindow.webContents.send(IPC_CHANNELS.TASK_ERROR, taskId, error);
    }
  });

  agentManager.on('exit', (taskId: string, code: number | null) => {
    const mainWindow = getMainWindow();
    if (mainWindow) {
      // Stop file watcher
      fileWatcher.unwatch(taskId);

      // Determine new status based on exit code
      const newStatus = code === 0 ? 'ai_review' : 'human_review';
      mainWindow.webContents.send(
        IPC_CHANNELS.TASK_STATUS_CHANGE,
        taskId,
        newStatus
      );
    }
  });

  // ============================================
  // File Watcher Events → Renderer
  // ============================================

  fileWatcher.on('progress', (taskId: string, plan: ImplementationPlan) => {
    const mainWindow = getMainWindow();
    if (mainWindow) {
      mainWindow.webContents.send(IPC_CHANNELS.TASK_PROGRESS, taskId, plan);
    }
  });

  fileWatcher.on('error', (taskId: string, error: string) => {
    const mainWindow = getMainWindow();
    if (mainWindow) {
      mainWindow.webContents.send(IPC_CHANNELS.TASK_ERROR, taskId, error);
    }
  });

  // ============================================
  // Roadmap Operations
  // ============================================

  ipcMain.handle(
    IPC_CHANNELS.ROADMAP_GET,
    async (_, projectId: string): Promise<IPCResult<Roadmap | null>> => {
      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }

      const roadmapPath = path.join(
        project.path,
        AUTO_BUILD_PATHS.ROADMAP_DIR,
        AUTO_BUILD_PATHS.ROADMAP_FILE
      );

      if (!existsSync(roadmapPath)) {
        return { success: true, data: null };
      }

      try {
        const content = readFileSync(roadmapPath, 'utf-8');
        const rawRoadmap = JSON.parse(content);

        // Transform snake_case to camelCase for frontend
        const roadmap: Roadmap = {
          id: rawRoadmap.id || `roadmap-${Date.now()}`,
          projectId,
          projectName: rawRoadmap.project_name || project.name,
          version: rawRoadmap.version || '1.0',
          vision: rawRoadmap.vision || '',
          targetAudience: {
            primary: rawRoadmap.target_audience?.primary || '',
            secondary: rawRoadmap.target_audience?.secondary || []
          },
          phases: (rawRoadmap.phases || []).map((phase: Record<string, unknown>) => ({
            id: phase.id,
            name: phase.name,
            description: phase.description,
            order: phase.order,
            status: phase.status || 'planned',
            features: phase.features || [],
            milestones: (phase.milestones as Array<Record<string, unknown>> || []).map((m) => ({
              id: m.id,
              title: m.title,
              description: m.description,
              features: m.features || [],
              status: m.status || 'planned',
              targetDate: m.target_date ? new Date(m.target_date as string) : undefined
            }))
          })),
          features: (rawRoadmap.features || []).map((feature: Record<string, unknown>) => ({
            id: feature.id,
            title: feature.title,
            description: feature.description,
            rationale: feature.rationale || '',
            priority: feature.priority || 'should',
            complexity: feature.complexity || 'medium',
            impact: feature.impact || 'medium',
            phaseId: feature.phase_id,
            dependencies: feature.dependencies || [],
            status: feature.status || 'idea',
            acceptanceCriteria: feature.acceptance_criteria || [],
            userStories: feature.user_stories || [],
            linkedSpecId: feature.linked_spec_id
          })),
          status: rawRoadmap.status || 'draft',
          createdAt: rawRoadmap.metadata?.created_at ? new Date(rawRoadmap.metadata.created_at) : new Date(),
          updatedAt: rawRoadmap.metadata?.updated_at ? new Date(rawRoadmap.metadata.updated_at) : new Date()
        };

        return { success: true, data: roadmap };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to read roadmap'
        };
      }
    }
  );

  ipcMain.on(
    IPC_CHANNELS.ROADMAP_GENERATE,
    (_, projectId: string) => {
      const mainWindow = getMainWindow();
      if (!mainWindow) return;

      const project = projectStore.getProject(projectId);
      if (!project) {
        mainWindow.webContents.send(
          IPC_CHANNELS.ROADMAP_ERROR,
          projectId,
          'Project not found'
        );
        return;
      }

      // Start roadmap generation via agent manager
      agentManager.startRoadmapGeneration(projectId, project.path, false);

      // Send initial progress
      mainWindow.webContents.send(
        IPC_CHANNELS.ROADMAP_PROGRESS,
        projectId,
        {
          phase: 'analyzing',
          progress: 10,
          message: 'Analyzing project structure...'
        } as RoadmapGenerationStatus
      );
    }
  );

  ipcMain.on(
    IPC_CHANNELS.ROADMAP_REFRESH,
    (_, projectId: string) => {
      const mainWindow = getMainWindow();
      if (!mainWindow) return;

      const project = projectStore.getProject(projectId);
      if (!project) {
        mainWindow.webContents.send(
          IPC_CHANNELS.ROADMAP_ERROR,
          projectId,
          'Project not found'
        );
        return;
      }

      // Start roadmap regeneration with refresh flag
      agentManager.startRoadmapGeneration(projectId, project.path, true);

      // Send initial progress
      mainWindow.webContents.send(
        IPC_CHANNELS.ROADMAP_PROGRESS,
        projectId,
        {
          phase: 'analyzing',
          progress: 10,
          message: 'Refreshing roadmap...'
        } as RoadmapGenerationStatus
      );
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.ROADMAP_UPDATE_FEATURE,
    async (
      _,
      projectId: string,
      featureId: string,
      status: RoadmapFeatureStatus
    ): Promise<IPCResult> => {
      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }

      const roadmapPath = path.join(
        project.path,
        AUTO_BUILD_PATHS.ROADMAP_DIR,
        AUTO_BUILD_PATHS.ROADMAP_FILE
      );

      if (!existsSync(roadmapPath)) {
        return { success: false, error: 'Roadmap not found' };
      }

      try {
        const content = readFileSync(roadmapPath, 'utf-8');
        const roadmap = JSON.parse(content);

        // Find and update the feature
        const feature = roadmap.features?.find((f: { id: string }) => f.id === featureId);
        if (!feature) {
          return { success: false, error: 'Feature not found' };
        }

        feature.status = status;
        roadmap.metadata = roadmap.metadata || {};
        roadmap.metadata.updated_at = new Date().toISOString();

        writeFileSync(roadmapPath, JSON.stringify(roadmap, null, 2));

        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to update feature'
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.ROADMAP_CONVERT_TO_SPEC,
    async (
      _,
      projectId: string,
      featureId: string
    ): Promise<IPCResult<Task>> => {
      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }

      const roadmapPath = path.join(
        project.path,
        AUTO_BUILD_PATHS.ROADMAP_DIR,
        AUTO_BUILD_PATHS.ROADMAP_FILE
      );

      if (!existsSync(roadmapPath)) {
        return { success: false, error: 'Roadmap not found' };
      }

      try {
        const content = readFileSync(roadmapPath, 'utf-8');
        const roadmap = JSON.parse(content);

        // Find the feature
        const feature = roadmap.features?.find((f: { id: string }) => f.id === featureId);
        if (!feature) {
          return { success: false, error: 'Feature not found' };
        }

        // Build task description from feature
        const taskDescription = `# ${feature.title}

${feature.description}

## Rationale
${feature.rationale || 'N/A'}

## User Stories
${(feature.user_stories || []).map((s: string) => `- ${s}`).join('\n') || 'N/A'}

## Acceptance Criteria
${(feature.acceptance_criteria || []).map((c: string) => `- [ ] ${c}`).join('\n') || 'N/A'}
`;

        // Generate task ID
        const taskId = `task-${Date.now()}`;

        // Start spec creation
        agentManager.startSpecCreation(taskId, project.path, taskDescription);

        // Update feature with linked spec
        feature.status = 'planned';
        feature.linked_spec_id = taskId;
        roadmap.metadata = roadmap.metadata || {};
        roadmap.metadata.updated_at = new Date().toISOString();
        writeFileSync(roadmapPath, JSON.stringify(roadmap, null, 2));

        // Create placeholder task
        const task: Task = {
          id: taskId,
          specId: '',
          projectId,
          title: feature.title,
          description: taskDescription,
          status: 'backlog',
          chunks: [],
          logs: [],
          createdAt: new Date(),
          updatedAt: new Date()
        };

        return { success: true, data: task };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to convert feature to spec'
        };
      }
    }
  );

  // ============================================
  // Roadmap Agent Events → Renderer
  // ============================================

  agentManager.on('roadmap-progress', (projectId: string, status: RoadmapGenerationStatus) => {
    const mainWindow = getMainWindow();
    if (mainWindow) {
      mainWindow.webContents.send(IPC_CHANNELS.ROADMAP_PROGRESS, projectId, status);
    }
  });

  agentManager.on('roadmap-complete', (projectId: string, roadmap: Roadmap) => {
    const mainWindow = getMainWindow();
    if (mainWindow) {
      mainWindow.webContents.send(IPC_CHANNELS.ROADMAP_COMPLETE, projectId, roadmap);
    }
  });

  agentManager.on('roadmap-error', (projectId: string, error: string) => {
    const mainWindow = getMainWindow();
    if (mainWindow) {
      mainWindow.webContents.send(IPC_CHANNELS.ROADMAP_ERROR, projectId, error);
    }
  });

  // ============================================
  // Context Operations
  // ============================================

  ipcMain.handle(
    IPC_CHANNELS.CONTEXT_GET,
    async (_, projectId: string): Promise<IPCResult<ProjectContextData>> => {
      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }

      try {
        // Load project index
        let projectIndex: ProjectIndex | null = null;
        const indexPath = path.join(project.path, AUTO_BUILD_PATHS.PROJECT_INDEX);
        if (existsSync(indexPath)) {
          const content = readFileSync(indexPath, 'utf-8');
          projectIndex = JSON.parse(content);
        }

        // Load graphiti state from most recent spec or project root
        let memoryState: GraphitiMemoryState | null = null;
        let memoryStatus: GraphitiMemoryStatus = {
          enabled: false,
          available: false,
          reason: 'Graphiti not configured'
        };

        // Check for graphiti state in specs
        const specsDir = path.join(project.path, AUTO_BUILD_PATHS.SPECS_DIR);
        if (existsSync(specsDir)) {
          const specDirs = readdirSync(specsDir)
            .filter((f: string) => {
              const specPath = path.join(specsDir, f);
              return statSync(specPath).isDirectory();
            })
            .sort()
            .reverse();

          for (const specDir of specDirs) {
            const statePath = path.join(specsDir, specDir, AUTO_BUILD_PATHS.GRAPHITI_STATE);
            if (existsSync(statePath)) {
              const stateContent = readFileSync(statePath, 'utf-8');
              memoryState = JSON.parse(stateContent);

              // If we found a state, update memory status
              if (memoryState?.initialized) {
                memoryStatus = {
                  enabled: true,
                  available: true,
                  database: memoryState.database || 'auto_build_memory',
                  host: process.env.GRAPHITI_FALKORDB_HOST || 'localhost',
                  port: parseInt(process.env.GRAPHITI_FALKORDB_PORT || '6380', 10)
                };
              }
              break;
            }
          }
        }

        // Check environment for Graphiti config if not found in specs
        if (!memoryState) {
          const graphitiEnabled = process.env.GRAPHITI_ENABLED?.toLowerCase() === 'true';
          const hasOpenAI = !!process.env.OPENAI_API_KEY;

          if (graphitiEnabled && hasOpenAI) {
            memoryStatus = {
              enabled: true,
              available: true,
              host: process.env.GRAPHITI_FALKORDB_HOST || 'localhost',
              port: parseInt(process.env.GRAPHITI_FALKORDB_PORT || '6380', 10),
              database: process.env.GRAPHITI_DATABASE || 'auto_build_memory'
            };
          } else if (graphitiEnabled && !hasOpenAI) {
            memoryStatus = {
              enabled: true,
              available: false,
              reason: 'OPENAI_API_KEY not set (required for Graphiti embeddings)'
            };
          }
        }

        // Load recent memories from file-based memory (session insights)
        const recentMemories: MemoryEpisode[] = [];
        if (existsSync(specsDir)) {
          const recentSpecDirs = readdirSync(specsDir)
            .filter((f: string) => {
              const specPath = path.join(specsDir, f);
              return statSync(specPath).isDirectory();
            })
            .sort()
            .reverse()
            .slice(0, 10); // Last 10 specs

          for (const specDir of recentSpecDirs) {
            // Look for session memory files
            const memoryDir = path.join(specsDir, specDir, 'memory');
            if (existsSync(memoryDir)) {
              const memoryFiles = readdirSync(memoryDir)
                .filter((f: string) => f.endsWith('.json'))
                .sort()
                .reverse();

              for (const memFile of memoryFiles.slice(0, 3)) {
                try {
                  const memPath = path.join(memoryDir, memFile);
                  const memContent = readFileSync(memPath, 'utf-8');
                  const memData = JSON.parse(memContent);

                  if (memData.insights) {
                    recentMemories.push({
                      id: `${specDir}-${memFile}`,
                      type: 'session_insight',
                      timestamp: memData.timestamp || new Date().toISOString(),
                      content: JSON.stringify(memData.insights, null, 2),
                      session_number: memData.session_number
                    });
                  }
                } catch {
                  // Skip invalid files
                }
              }
            }
          }
        }

        return {
          success: true,
          data: {
            projectIndex,
            memoryStatus,
            memoryState,
            recentMemories: recentMemories.slice(0, 20),
            isLoading: false
          }
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to load project context'
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.CONTEXT_REFRESH_INDEX,
    async (_, projectId: string): Promise<IPCResult<ProjectIndex>> => {
      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }

      try {
        // Run the analyzer script to regenerate project_index.json
        const autoBuildSource = getAutoBuildSourcePath();

        if (!autoBuildSource) {
          return {
            success: false,
            error: 'Auto-build source path not configured'
          };
        }

        const analyzerPath = path.join(autoBuildSource, 'analyzer.py');
        const indexOutputPath = path.join(project.path, AUTO_BUILD_PATHS.PROJECT_INDEX);

        // Run analyzer
        await new Promise<void>((resolve, reject) => {
          const proc = spawn('python', [
            analyzerPath,
            '--project-dir', project.path,
            '--output', indexOutputPath
          ], {
            cwd: project.path,
            env: { ...process.env }
          });

          proc.on('close', (code: number) => {
            if (code === 0) {
              resolve();
            } else {
              reject(new Error(`Analyzer exited with code ${code}`));
            }
          });

          proc.on('error', reject);
        });

        // Read the new index
        if (existsSync(indexOutputPath)) {
          const content = readFileSync(indexOutputPath, 'utf-8');
          const projectIndex = JSON.parse(content);
          return { success: true, data: projectIndex };
        }

        return { success: false, error: 'Failed to generate project index' };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to refresh project index'
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.CONTEXT_MEMORY_STATUS,
    async (_, projectId: string): Promise<IPCResult<GraphitiMemoryStatus>> => {
      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }

      // Check environment for Graphiti config
      const graphitiEnabled = process.env.GRAPHITI_ENABLED?.toLowerCase() === 'true';
      const hasOpenAI = !!process.env.OPENAI_API_KEY;

      if (!graphitiEnabled) {
        return {
          success: true,
          data: {
            enabled: false,
            available: false,
            reason: 'GRAPHITI_ENABLED not set to true'
          }
        };
      }

      if (!hasOpenAI) {
        return {
          success: true,
          data: {
            enabled: true,
            available: false,
            reason: 'OPENAI_API_KEY not set (required for embeddings)'
          }
        };
      }

      return {
        success: true,
        data: {
          enabled: true,
          available: true,
          host: process.env.GRAPHITI_FALKORDB_HOST || 'localhost',
          port: parseInt(process.env.GRAPHITI_FALKORDB_PORT || '6380', 10),
          database: process.env.GRAPHITI_DATABASE || 'auto_build_memory'
        }
      };
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.CONTEXT_SEARCH_MEMORIES,
    async (_, projectId: string, query: string): Promise<IPCResult<ContextSearchResult[]>> => {
      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }

      // For now, do simple text search in file-based memories
      // Graphiti search would require running Python subprocess
      const results: ContextSearchResult[] = [];
      const queryLower = query.toLowerCase();

      const specsDir = path.join(project.path, AUTO_BUILD_PATHS.SPECS_DIR);
      if (existsSync(specsDir)) {
        const allSpecDirs = readdirSync(specsDir)
          .filter((f: string) => {
            const specPath = path.join(specsDir, f);
            return statSync(specPath).isDirectory();
          });

        for (const specDir of allSpecDirs) {
          const memoryDir = path.join(specsDir, specDir, 'memory');
          if (existsSync(memoryDir)) {
            const memoryFiles = readdirSync(memoryDir)
              .filter((f: string) => f.endsWith('.json'));

            for (const memFile of memoryFiles) {
              try {
                const memPath = path.join(memoryDir, memFile);
                const memContent = readFileSync(memPath, 'utf-8');

                if (memContent.toLowerCase().includes(queryLower)) {
                  const memData = JSON.parse(memContent);
                  results.push({
                    content: JSON.stringify(memData.insights || memData, null, 2),
                    score: 1.0,
                    type: 'session_insight'
                  });
                }
              } catch {
                // Skip invalid files
              }
            }
          }
        }
      }

      return { success: true, data: results.slice(0, 20) };
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.CONTEXT_GET_MEMORIES,
    async (_, projectId: string, limit: number = 20): Promise<IPCResult<MemoryEpisode[]>> => {
      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }

      const memories: MemoryEpisode[] = [];
      const specsDir = path.join(project.path, AUTO_BUILD_PATHS.SPECS_DIR);

      if (existsSync(specsDir)) {
        const sortedSpecDirs = readdirSync(specsDir)
          .filter((f: string) => {
            const specPath = path.join(specsDir, f);
            return statSync(specPath).isDirectory();
          })
          .sort()
          .reverse();

        for (const specDir of sortedSpecDirs) {
          const memoryDir = path.join(specsDir, specDir, 'memory');
          if (existsSync(memoryDir)) {
            const memoryFiles = readdirSync(memoryDir)
              .filter((f: string) => f.endsWith('.json'))
              .sort()
              .reverse();

            for (const memFile of memoryFiles) {
              try {
                const memPath = path.join(memoryDir, memFile);
                const memContent = readFileSync(memPath, 'utf-8');
                const memData = JSON.parse(memContent);

                memories.push({
                  id: `${specDir}-${memFile}`,
                  type: memData.type || 'session_insight',
                  timestamp: memData.timestamp || new Date().toISOString(),
                  content: JSON.stringify(memData.insights || memData, null, 2),
                  session_number: memData.session_number
                });

                if (memories.length >= limit) {
                  break;
                }
              } catch {
                // Skip invalid files
              }
            }
          }

          if (memories.length >= limit) {
            break;
          }
        }
      }

      return { success: true, data: memories };
    }
  );

  // ============================================
  // Environment Configuration Operations
  // ============================================

  /**
   * Parse .env file into key-value object
   */
  const parseEnvFile = (content: string): Record<string, string> => {
    const result: Record<string, string> = {};
    const lines = content.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      // Skip empty lines and comments
      if (!trimmed || trimmed.startsWith('#')) continue;

      const equalsIndex = trimmed.indexOf('=');
      if (equalsIndex > 0) {
        const key = trimmed.substring(0, equalsIndex).trim();
        let value = trimmed.substring(equalsIndex + 1).trim();
        // Remove quotes if present
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        result[key] = value;
      }
    }
    return result;
  };

  /**
   * Generate .env file content from config
   */
  const generateEnvContent = (
    config: Partial<ProjectEnvConfig>,
    existingContent?: string
  ): string => {
    // Parse existing content to preserve comments and structure
    const existingVars = existingContent ? parseEnvFile(existingContent) : {};

    // Update with new values
    if (config.claudeOAuthToken !== undefined) {
      existingVars['CLAUDE_CODE_OAUTH_TOKEN'] = config.claudeOAuthToken;
    }
    if (config.autoBuildModel !== undefined) {
      existingVars['AUTO_BUILD_MODEL'] = config.autoBuildModel;
    }
    if (config.linearApiKey !== undefined) {
      existingVars['LINEAR_API_KEY'] = config.linearApiKey;
    }
    if (config.linearTeamId !== undefined) {
      existingVars['LINEAR_TEAM_ID'] = config.linearTeamId;
    }
    if (config.linearProjectId !== undefined) {
      existingVars['LINEAR_PROJECT_ID'] = config.linearProjectId;
    }
    if (config.linearRealtimeSync !== undefined) {
      existingVars['LINEAR_REALTIME_SYNC'] = config.linearRealtimeSync ? 'true' : 'false';
    }
    // GitHub Integration
    if (config.githubToken !== undefined) {
      existingVars['GITHUB_TOKEN'] = config.githubToken;
    }
    if (config.githubRepo !== undefined) {
      existingVars['GITHUB_REPO'] = config.githubRepo;
    }
    if (config.githubAutoSync !== undefined) {
      existingVars['GITHUB_AUTO_SYNC'] = config.githubAutoSync ? 'true' : 'false';
    }
    if (config.graphitiEnabled !== undefined) {
      existingVars['GRAPHITI_ENABLED'] = config.graphitiEnabled ? 'true' : 'false';
    }
    if (config.openaiApiKey !== undefined) {
      existingVars['OPENAI_API_KEY'] = config.openaiApiKey;
    }
    if (config.graphitiFalkorDbHost !== undefined) {
      existingVars['GRAPHITI_FALKORDB_HOST'] = config.graphitiFalkorDbHost;
    }
    if (config.graphitiFalkorDbPort !== undefined) {
      existingVars['GRAPHITI_FALKORDB_PORT'] = String(config.graphitiFalkorDbPort);
    }
    if (config.graphitiFalkorDbPassword !== undefined) {
      existingVars['GRAPHITI_FALKORDB_PASSWORD'] = config.graphitiFalkorDbPassword;
    }
    if (config.graphitiDatabase !== undefined) {
      existingVars['GRAPHITI_DATABASE'] = config.graphitiDatabase;
    }
    if (config.enableFancyUi !== undefined) {
      existingVars['ENABLE_FANCY_UI'] = config.enableFancyUi ? 'true' : 'false';
    }

    // Generate content with sections
    let content = `# Auto Claude Framework Environment Variables
# Managed by Auto Claude UI

# Claude Code OAuth Token (REQUIRED)
CLAUDE_CODE_OAUTH_TOKEN=${existingVars['CLAUDE_CODE_OAUTH_TOKEN'] || ''}

# Model override (OPTIONAL)
${existingVars['AUTO_BUILD_MODEL'] ? `AUTO_BUILD_MODEL=${existingVars['AUTO_BUILD_MODEL']}` : '# AUTO_BUILD_MODEL=claude-opus-4-5-20251101'}

# =============================================================================
# LINEAR INTEGRATION (OPTIONAL)
# =============================================================================
${existingVars['LINEAR_API_KEY'] ? `LINEAR_API_KEY=${existingVars['LINEAR_API_KEY']}` : '# LINEAR_API_KEY='}
${existingVars['LINEAR_TEAM_ID'] ? `LINEAR_TEAM_ID=${existingVars['LINEAR_TEAM_ID']}` : '# LINEAR_TEAM_ID='}
${existingVars['LINEAR_PROJECT_ID'] ? `LINEAR_PROJECT_ID=${existingVars['LINEAR_PROJECT_ID']}` : '# LINEAR_PROJECT_ID='}
${existingVars['LINEAR_REALTIME_SYNC'] !== undefined ? `LINEAR_REALTIME_SYNC=${existingVars['LINEAR_REALTIME_SYNC']}` : '# LINEAR_REALTIME_SYNC=false'}

# =============================================================================
# GITHUB INTEGRATION (OPTIONAL)
# =============================================================================
${existingVars['GITHUB_TOKEN'] ? `GITHUB_TOKEN=${existingVars['GITHUB_TOKEN']}` : '# GITHUB_TOKEN='}
${existingVars['GITHUB_REPO'] ? `GITHUB_REPO=${existingVars['GITHUB_REPO']}` : '# GITHUB_REPO=owner/repo'}
${existingVars['GITHUB_AUTO_SYNC'] !== undefined ? `GITHUB_AUTO_SYNC=${existingVars['GITHUB_AUTO_SYNC']}` : '# GITHUB_AUTO_SYNC=false'}

# =============================================================================
# UI SETTINGS (OPTIONAL)
# =============================================================================
${existingVars['ENABLE_FANCY_UI'] !== undefined ? `ENABLE_FANCY_UI=${existingVars['ENABLE_FANCY_UI']}` : '# ENABLE_FANCY_UI=true'}

# =============================================================================
# GRAPHITI MEMORY INTEGRATION (OPTIONAL)
# =============================================================================
${existingVars['GRAPHITI_ENABLED'] ? `GRAPHITI_ENABLED=${existingVars['GRAPHITI_ENABLED']}` : '# GRAPHITI_ENABLED=false'}
${existingVars['OPENAI_API_KEY'] ? `OPENAI_API_KEY=${existingVars['OPENAI_API_KEY']}` : '# OPENAI_API_KEY='}
${existingVars['GRAPHITI_FALKORDB_HOST'] ? `GRAPHITI_FALKORDB_HOST=${existingVars['GRAPHITI_FALKORDB_HOST']}` : '# GRAPHITI_FALKORDB_HOST=localhost'}
${existingVars['GRAPHITI_FALKORDB_PORT'] ? `GRAPHITI_FALKORDB_PORT=${existingVars['GRAPHITI_FALKORDB_PORT']}` : '# GRAPHITI_FALKORDB_PORT=6380'}
${existingVars['GRAPHITI_FALKORDB_PASSWORD'] ? `GRAPHITI_FALKORDB_PASSWORD=${existingVars['GRAPHITI_FALKORDB_PASSWORD']}` : '# GRAPHITI_FALKORDB_PASSWORD='}
${existingVars['GRAPHITI_DATABASE'] ? `GRAPHITI_DATABASE=${existingVars['GRAPHITI_DATABASE']}` : '# GRAPHITI_DATABASE=auto_build_memory'}
`;

    return content;
  };

  ipcMain.handle(
    IPC_CHANNELS.ENV_GET,
    async (_, projectId: string): Promise<IPCResult<ProjectEnvConfig>> => {
      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }

      if (!project.autoBuildPath) {
        return { success: false, error: 'Project not initialized' };
      }

      const envPath = path.join(project.path, project.autoBuildPath, '.env');

      // Load global settings for fallbacks
      let globalSettings: AppSettings = { ...DEFAULT_APP_SETTINGS };
      if (existsSync(settingsPath)) {
        try {
          const content = readFileSync(settingsPath, 'utf-8');
          globalSettings = { ...globalSettings, ...JSON.parse(content) };
        } catch {
          // Use defaults
        }
      }

      // Default config
      const config: ProjectEnvConfig = {
        claudeAuthStatus: 'not_configured',
        linearEnabled: false,
        githubEnabled: false,
        graphitiEnabled: false,
        enableFancyUi: true,
        claudeTokenIsGlobal: false,
        openaiKeyIsGlobal: false
      };

      // Parse project-specific .env if it exists
      let vars: Record<string, string> = {};
      if (existsSync(envPath)) {
        try {
          const content = readFileSync(envPath, 'utf-8');
          vars = parseEnvFile(content);
        } catch {
          // Continue with empty vars
        }
      }

      // Claude OAuth Token: project-specific takes precedence, then global
      if (vars['CLAUDE_CODE_OAUTH_TOKEN']) {
        config.claudeOAuthToken = vars['CLAUDE_CODE_OAUTH_TOKEN'];
        config.claudeAuthStatus = 'token_set';
        config.claudeTokenIsGlobal = false;
      } else if (globalSettings.globalClaudeOAuthToken) {
        config.claudeOAuthToken = globalSettings.globalClaudeOAuthToken;
        config.claudeAuthStatus = 'token_set';
        config.claudeTokenIsGlobal = true;
      }

      if (vars['AUTO_BUILD_MODEL']) {
        config.autoBuildModel = vars['AUTO_BUILD_MODEL'];
      }

      if (vars['LINEAR_API_KEY']) {
        config.linearEnabled = true;
        config.linearApiKey = vars['LINEAR_API_KEY'];
      }
      if (vars['LINEAR_TEAM_ID']) {
        config.linearTeamId = vars['LINEAR_TEAM_ID'];
      }
      if (vars['LINEAR_PROJECT_ID']) {
        config.linearProjectId = vars['LINEAR_PROJECT_ID'];
      }
      if (vars['LINEAR_REALTIME_SYNC']?.toLowerCase() === 'true') {
        config.linearRealtimeSync = true;
      }

      // GitHub config
      if (vars['GITHUB_TOKEN']) {
        config.githubEnabled = true;
        config.githubToken = vars['GITHUB_TOKEN'];
      }
      if (vars['GITHUB_REPO']) {
        config.githubRepo = vars['GITHUB_REPO'];
      }
      if (vars['GITHUB_AUTO_SYNC']?.toLowerCase() === 'true') {
        config.githubAutoSync = true;
      }

      if (vars['GRAPHITI_ENABLED']?.toLowerCase() === 'true') {
        config.graphitiEnabled = true;
      }

      // OpenAI API Key: project-specific takes precedence, then global
      if (vars['OPENAI_API_KEY']) {
        config.openaiApiKey = vars['OPENAI_API_KEY'];
        config.openaiKeyIsGlobal = false;
      } else if (globalSettings.globalOpenAIApiKey) {
        config.openaiApiKey = globalSettings.globalOpenAIApiKey;
        config.openaiKeyIsGlobal = true;
      }

      if (vars['GRAPHITI_FALKORDB_HOST']) {
        config.graphitiFalkorDbHost = vars['GRAPHITI_FALKORDB_HOST'];
      }
      if (vars['GRAPHITI_FALKORDB_PORT']) {
        config.graphitiFalkorDbPort = parseInt(vars['GRAPHITI_FALKORDB_PORT'], 10);
      }
      if (vars['GRAPHITI_FALKORDB_PASSWORD']) {
        config.graphitiFalkorDbPassword = vars['GRAPHITI_FALKORDB_PASSWORD'];
      }
      if (vars['GRAPHITI_DATABASE']) {
        config.graphitiDatabase = vars['GRAPHITI_DATABASE'];
      }

      if (vars['ENABLE_FANCY_UI']?.toLowerCase() === 'false') {
        config.enableFancyUi = false;
      }

      return { success: true, data: config };
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.ENV_UPDATE,
    async (_, projectId: string, config: Partial<ProjectEnvConfig>): Promise<IPCResult> => {
      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }

      if (!project.autoBuildPath) {
        return { success: false, error: 'Project not initialized' };
      }

      const envPath = path.join(project.path, project.autoBuildPath, '.env');

      try {
        // Read existing content if file exists
        let existingContent: string | undefined;
        if (existsSync(envPath)) {
          existingContent = readFileSync(envPath, 'utf-8');
        }

        // Generate new content
        const newContent = generateEnvContent(config, existingContent);

        // Write to file
        writeFileSync(envPath, newContent);

        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to update .env file'
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.ENV_CHECK_CLAUDE_AUTH,
    async (_, projectId: string): Promise<IPCResult<ClaudeAuthResult>> => {
      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }

      try {
        // Check if Claude CLI is available and authenticated
        const result = await new Promise<ClaudeAuthResult>((resolve) => {
          const proc = spawn('claude', ['--version'], {
            cwd: project.path,
            env: { ...process.env },
            shell: true
          });

          let stdout = '';
          let stderr = '';

          proc.stdout?.on('data', (data: Buffer) => {
            stdout += data.toString();
          });

          proc.stderr?.on('data', (data: Buffer) => {
            stderr += data.toString();
          });

          proc.on('close', (code: number | null) => {
            if (code === 0) {
              // Claude CLI is available, check if authenticated
              // Run a simple command that requires auth
              const authCheck = spawn('claude', ['api', '--help'], {
                cwd: project.path,
                env: { ...process.env },
                shell: true
              });

              authCheck.on('close', (authCode: number | null) => {
                resolve({
                  success: true,
                  authenticated: authCode === 0
                });
              });

              authCheck.on('error', () => {
                resolve({
                  success: true,
                  authenticated: false,
                  error: 'Could not verify authentication'
                });
              });
            } else {
              resolve({
                success: false,
                authenticated: false,
                error: 'Claude CLI not found. Please install it first.'
              });
            }
          });

          proc.on('error', () => {
            resolve({
              success: false,
              authenticated: false,
              error: 'Claude CLI not found. Please install it first.'
            });
          });
        });

        return { success: true, data: result };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to check Claude auth'
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.ENV_INVOKE_CLAUDE_SETUP,
    async (_, projectId: string): Promise<IPCResult<ClaudeAuthResult>> => {
      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }

      try {
        // Run claude setup-token which will open browser for OAuth
        const result = await new Promise<ClaudeAuthResult>((resolve) => {
          const proc = spawn('claude', ['setup-token'], {
            cwd: project.path,
            env: { ...process.env },
            shell: true,
            stdio: 'inherit' // This allows the terminal to handle the interactive auth
          });

          proc.on('close', (code: number | null) => {
            if (code === 0) {
              resolve({
                success: true,
                authenticated: true
              });
            } else {
              resolve({
                success: false,
                authenticated: false,
                error: 'Setup cancelled or failed'
              });
            }
          });

          proc.on('error', (err: Error) => {
            resolve({
              success: false,
              authenticated: false,
              error: err.message
            });
          });
        });

        return { success: true, data: result };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to invoke Claude setup'
        };
      }
    }
  );

  // ============================================
  // Linear Integration Operations
  // ============================================

  /**
   * Helper to get Linear API key from project env
   */
  const getLinearApiKey = (project: Project): string | null => {
    if (!project.autoBuildPath) return null;
    const envPath = path.join(project.path, project.autoBuildPath, '.env');
    if (!existsSync(envPath)) return null;

    try {
      const content = readFileSync(envPath, 'utf-8');
      const vars = parseEnvFile(content);
      return vars['LINEAR_API_KEY'] || null;
    } catch {
      return null;
    }
  };

  /**
   * Make a request to the Linear API
   */
  const linearGraphQL = async (
    apiKey: string,
    query: string,
    variables?: Record<string, unknown>
  ): Promise<unknown> => {
    const response = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': apiKey
      },
      body: JSON.stringify({ query, variables })
    });

    if (!response.ok) {
      throw new Error(`Linear API error: ${response.status} ${response.statusText}`);
    }

    const result = await response.json();
    if (result.errors) {
      throw new Error(result.errors[0]?.message || 'Linear API error');
    }

    return result.data;
  };

  ipcMain.handle(
    IPC_CHANNELS.LINEAR_CHECK_CONNECTION,
    async (_, projectId: string): Promise<IPCResult<LinearSyncStatus>> => {
      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }

      const apiKey = getLinearApiKey(project);
      if (!apiKey) {
        return {
          success: true,
          data: {
            connected: false,
            error: 'No Linear API key configured'
          }
        };
      }

      try {
        const query = `
          query {
            viewer {
              id
              name
            }
            teams {
              nodes {
                id
                name
                key
              }
            }
          }
        `;

        const data = await linearGraphQL(apiKey, query) as {
          viewer: { id: string; name: string };
          teams: { nodes: Array<{ id: string; name: string; key: string }> };
        };

        // Get issue count for the first team
        let issueCount = 0;
        let teamName: string | undefined;

        if (data.teams.nodes.length > 0) {
          teamName = data.teams.nodes[0].name;
          const countQuery = `
            query($teamId: String!) {
              team(id: $teamId) {
                issues {
                  totalCount: nodes { id }
                }
              }
            }
          `;
          // Get approximate count
          const issuesQuery = `
            query($teamId: String!) {
              issues(filter: { team: { id: { eq: $teamId } } }, first: 0) {
                pageInfo {
                  hasNextPage
                }
              }
            }
          `;

          // Simple count estimation - get first 250 issues
          const countData = await linearGraphQL(apiKey, `
            query($teamId: String!) {
              issues(filter: { team: { id: { eq: $teamId } } }, first: 250) {
                nodes { id }
              }
            }
          `, { teamId: data.teams.nodes[0].id }) as {
            issues: { nodes: Array<{ id: string }> };
          };
          issueCount = countData.issues.nodes.length;
        }

        return {
          success: true,
          data: {
            connected: true,
            teamName,
            issueCount,
            lastSyncedAt: new Date().toISOString()
          }
        };
      } catch (error) {
        return {
          success: true,
          data: {
            connected: false,
            error: error instanceof Error ? error.message : 'Failed to connect to Linear'
          }
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.LINEAR_GET_TEAMS,
    async (_, projectId: string): Promise<IPCResult<LinearTeam[]>> => {
      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }

      const apiKey = getLinearApiKey(project);
      if (!apiKey) {
        return { success: false, error: 'No Linear API key configured' };
      }

      try {
        const query = `
          query {
            teams {
              nodes {
                id
                name
                key
              }
            }
          }
        `;

        const data = await linearGraphQL(apiKey, query) as {
          teams: { nodes: LinearTeam[] };
        };

        return { success: true, data: data.teams.nodes };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to fetch teams'
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.LINEAR_GET_PROJECTS,
    async (_, projectId: string, teamId: string): Promise<IPCResult<LinearProject[]>> => {
      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }

      const apiKey = getLinearApiKey(project);
      if (!apiKey) {
        return { success: false, error: 'No Linear API key configured' };
      }

      try {
        const query = `
          query($teamId: String!) {
            team(id: $teamId) {
              projects {
                nodes {
                  id
                  name
                  state
                }
              }
            }
          }
        `;

        const data = await linearGraphQL(apiKey, query, { teamId }) as {
          team: { projects: { nodes: LinearProject[] } };
        };

        return { success: true, data: data.team.projects.nodes };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to fetch projects'
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.LINEAR_GET_ISSUES,
    async (_, projectId: string, teamId?: string, linearProjectId?: string): Promise<IPCResult<LinearIssue[]>> => {
      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }

      const apiKey = getLinearApiKey(project);
      if (!apiKey) {
        return { success: false, error: 'No Linear API key configured' };
      }

      try {
        // Build filter based on provided parameters
        const filters: string[] = [];
        if (teamId) {
          filters.push(`team: { id: { eq: "${teamId}" } }`);
        }
        if (linearProjectId) {
          filters.push(`project: { id: { eq: "${linearProjectId}" } }`);
        }

        const filterClause = filters.length > 0 ? `filter: { ${filters.join(', ')} }` : '';

        const query = `
          query {
            issues(${filterClause}, first: 250, orderBy: updatedAt) {
              nodes {
                id
                identifier
                title
                description
                state {
                  id
                  name
                  type
                }
                priority
                priorityLabel
                labels {
                  nodes {
                    id
                    name
                    color
                  }
                }
                assignee {
                  id
                  name
                  email
                }
                project {
                  id
                  name
                }
                createdAt
                updatedAt
                url
              }
            }
          }
        `;

        const data = await linearGraphQL(apiKey, query) as {
          issues: {
            nodes: Array<{
              id: string;
              identifier: string;
              title: string;
              description?: string;
              state: { id: string; name: string; type: string };
              priority: number;
              priorityLabel: string;
              labels: { nodes: Array<{ id: string; name: string; color: string }> };
              assignee?: { id: string; name: string; email: string };
              project?: { id: string; name: string };
              createdAt: string;
              updatedAt: string;
              url: string;
            }>;
          };
        };

        // Transform to our LinearIssue format
        const issues: LinearIssue[] = data.issues.nodes.map(issue => ({
          ...issue,
          labels: issue.labels.nodes
        }));

        return { success: true, data: issues };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to fetch issues'
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.LINEAR_IMPORT_ISSUES,
    async (_, projectId: string, issueIds: string[]): Promise<IPCResult<LinearImportResult>> => {
      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }

      const apiKey = getLinearApiKey(project);
      if (!apiKey) {
        return { success: false, error: 'No Linear API key configured' };
      }

      try {
        // First, fetch the full details of selected issues
        const query = `
          query($ids: [String!]!) {
            issues(filter: { id: { in: $ids } }) {
              nodes {
                id
                identifier
                title
                description
                state {
                  id
                  name
                  type
                }
                priority
                priorityLabel
                labels {
                  nodes {
                    id
                    name
                    color
                  }
                }
                url
              }
            }
          }
        `;

        const data = await linearGraphQL(apiKey, query, { ids: issueIds }) as {
          issues: {
            nodes: Array<{
              id: string;
              identifier: string;
              title: string;
              description?: string;
              state: { id: string; name: string; type: string };
              priority: number;
              priorityLabel: string;
              labels: { nodes: Array<{ id: string; name: string; color: string }> };
              url: string;
            }>;
          };
        };

        let imported = 0;
        let failed = 0;
        const errors: string[] = [];

        // Create tasks for each imported issue
        for (const issue of data.issues.nodes) {
          try {
            // Build description from Linear issue
            const labels = issue.labels.nodes.map(l => l.name).join(', ');
            const description = `# ${issue.title}

**Linear Issue:** [${issue.identifier}](${issue.url})
**Priority:** ${issue.priorityLabel}
**Status:** ${issue.state.name}
${labels ? `**Labels:** ${labels}` : ''}

## Description

${issue.description || 'No description provided.'}
`;

            // Generate task ID
            const taskId = `task-${Date.now()}-${imported}`;

            // Start spec creation for this issue
            agentManager.startSpecCreation(taskId, project.path, description);

            imported++;
          } catch (err) {
            failed++;
            errors.push(`Failed to import ${issue.identifier}: ${err instanceof Error ? err.message : 'Unknown error'}`);
          }
        }

        return {
          success: true,
          data: {
            success: failed === 0,
            imported,
            failed,
            errors: errors.length > 0 ? errors : undefined
          }
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to import issues'
        };
      }
    }
  );

  // ============================================
  // GitHub Integration Operations
  // ============================================

  /**
   * Helper to get GitHub config from project env
   */
  const getGitHubConfig = (project: Project): { token: string; repo: string } | null => {
    if (!project.autoBuildPath) return null;
    const envPath = path.join(project.path, project.autoBuildPath, '.env');
    if (!existsSync(envPath)) return null;

    try {
      const content = readFileSync(envPath, 'utf-8');
      const vars = parseEnvFile(content);
      const token = vars['GITHUB_TOKEN'];
      const repo = vars['GITHUB_REPO'];

      if (!token || !repo) return null;
      return { token, repo };
    } catch {
      return null;
    }
  };

  /**
   * Make a request to the GitHub API
   */
  const githubFetch = async (
    token: string,
    endpoint: string,
    options: RequestInit = {}
  ): Promise<unknown> => {
    const url = endpoint.startsWith('http')
      ? endpoint
      : `https://api.github.com${endpoint}`;

    const response = await fetch(url, {
      ...options,
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'Auto-Claude-UI',
        ...options.headers
      }
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`GitHub API error: ${response.status} ${response.statusText} - ${errorBody}`);
    }

    return response.json();
  };

  ipcMain.handle(
    IPC_CHANNELS.GITHUB_CHECK_CONNECTION,
    async (_, projectId: string): Promise<IPCResult<GitHubSyncStatus>> => {
      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }

      const config = getGitHubConfig(project);
      if (!config) {
        return {
          success: true,
          data: {
            connected: false,
            error: 'No GitHub token or repository configured'
          }
        };
      }

      try {
        // Fetch repo info
        const repoData = await githubFetch(
          config.token,
          `/repos/${config.repo}`
        ) as { full_name: string; description?: string };

        // Count open issues
        const issuesData = await githubFetch(
          config.token,
          `/repos/${config.repo}/issues?state=open&per_page=1`
        ) as unknown[];

        const openCount = Array.isArray(issuesData) ? issuesData.length : 0;

        return {
          success: true,
          data: {
            connected: true,
            repoFullName: repoData.full_name,
            repoDescription: repoData.description,
            issueCount: openCount,
            lastSyncedAt: new Date().toISOString()
          }
        };
      } catch (error) {
        return {
          success: true,
          data: {
            connected: false,
            error: error instanceof Error ? error.message : 'Failed to connect to GitHub'
          }
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.GITHUB_GET_REPOSITORIES,
    async (_, projectId: string): Promise<IPCResult<GitHubRepository[]>> => {
      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }

      const config = getGitHubConfig(project);
      if (!config) {
        return { success: false, error: 'No GitHub token configured' };
      }

      try {
        const repos = await githubFetch(
          config.token,
          '/user/repos?per_page=100&sort=updated'
        ) as Array<{
          id: number;
          name: string;
          full_name: string;
          description?: string;
          html_url: string;
          default_branch: string;
          private: boolean;
          owner: { login: string; avatar_url?: string };
        }>;

        const result: GitHubRepository[] = repos.map(repo => ({
          id: repo.id,
          name: repo.name,
          fullName: repo.full_name,
          description: repo.description,
          url: repo.html_url,
          defaultBranch: repo.default_branch,
          private: repo.private,
          owner: {
            login: repo.owner.login,
            avatarUrl: repo.owner.avatar_url
          }
        }));

        return { success: true, data: result };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to fetch repositories'
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.GITHUB_GET_ISSUES,
    async (_, projectId: string, state: 'open' | 'closed' | 'all' = 'open'): Promise<IPCResult<GitHubIssue[]>> => {
      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }

      const config = getGitHubConfig(project);
      if (!config) {
        return { success: false, error: 'No GitHub token or repository configured' };
      }

      try {
        const issues = await githubFetch(
          config.token,
          `/repos/${config.repo}/issues?state=${state}&per_page=100&sort=updated`
        ) as Array<{
          id: number;
          number: number;
          title: string;
          body?: string;
          state: 'open' | 'closed';
          labels: Array<{ id: number; name: string; color: string; description?: string }>;
          assignees: Array<{ login: string; avatar_url?: string }>;
          user: { login: string; avatar_url?: string };
          milestone?: { id: number; title: string; state: 'open' | 'closed' };
          created_at: string;
          updated_at: string;
          closed_at?: string;
          comments: number;
          url: string;
          html_url: string;
          pull_request?: unknown;
        }>;

        // Filter out pull requests
        const issuesOnly = issues.filter(issue => !issue.pull_request);

        const result: GitHubIssue[] = issuesOnly.map(issue => ({
          id: issue.id,
          number: issue.number,
          title: issue.title,
          body: issue.body,
          state: issue.state,
          labels: issue.labels,
          assignees: issue.assignees.map(a => ({
            login: a.login,
            avatarUrl: a.avatar_url
          })),
          author: {
            login: issue.user.login,
            avatarUrl: issue.user.avatar_url
          },
          milestone: issue.milestone,
          createdAt: issue.created_at,
          updatedAt: issue.updated_at,
          closedAt: issue.closed_at,
          commentsCount: issue.comments,
          url: issue.url,
          htmlUrl: issue.html_url,
          repoFullName: config.repo
        }));

        return { success: true, data: result };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to fetch issues'
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.GITHUB_GET_ISSUE,
    async (_, projectId: string, issueNumber: number): Promise<IPCResult<GitHubIssue>> => {
      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }

      const config = getGitHubConfig(project);
      if (!config) {
        return { success: false, error: 'No GitHub token or repository configured' };
      }

      try {
        const issue = await githubFetch(
          config.token,
          `/repos/${config.repo}/issues/${issueNumber}`
        ) as {
          id: number;
          number: number;
          title: string;
          body?: string;
          state: 'open' | 'closed';
          labels: Array<{ id: number; name: string; color: string; description?: string }>;
          assignees: Array<{ login: string; avatar_url?: string }>;
          user: { login: string; avatar_url?: string };
          milestone?: { id: number; title: string; state: 'open' | 'closed' };
          created_at: string;
          updated_at: string;
          closed_at?: string;
          comments: number;
          url: string;
          html_url: string;
        };

        const result: GitHubIssue = {
          id: issue.id,
          number: issue.number,
          title: issue.title,
          body: issue.body,
          state: issue.state,
          labels: issue.labels,
          assignees: issue.assignees.map(a => ({
            login: a.login,
            avatarUrl: a.avatar_url
          })),
          author: {
            login: issue.user.login,
            avatarUrl: issue.user.avatar_url
          },
          milestone: issue.milestone,
          createdAt: issue.created_at,
          updatedAt: issue.updated_at,
          closedAt: issue.closed_at,
          commentsCount: issue.comments,
          url: issue.url,
          htmlUrl: issue.html_url,
          repoFullName: config.repo
        };

        return { success: true, data: result };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to fetch issue'
        };
      }
    }
  );

  ipcMain.on(
    IPC_CHANNELS.GITHUB_INVESTIGATE_ISSUE,
    async (_, projectId: string, issueNumber: number) => {
      const mainWindow = getMainWindow();
      if (!mainWindow) return;

      const project = projectStore.getProject(projectId);
      if (!project) {
        mainWindow.webContents.send(
          IPC_CHANNELS.GITHUB_INVESTIGATION_ERROR,
          projectId,
          'Project not found'
        );
        return;
      }

      const config = getGitHubConfig(project);
      if (!config) {
        mainWindow.webContents.send(
          IPC_CHANNELS.GITHUB_INVESTIGATION_ERROR,
          projectId,
          'No GitHub token or repository configured'
        );
        return;
      }

      try {
        // Send progress update: fetching issue
        mainWindow.webContents.send(
          IPC_CHANNELS.GITHUB_INVESTIGATION_PROGRESS,
          projectId,
          {
            phase: 'fetching',
            issueNumber,
            progress: 10,
            message: 'Fetching issue details...'
          } as GitHubInvestigationStatus
        );

        // Fetch the issue
        const issue = await githubFetch(
          config.token,
          `/repos/${config.repo}/issues/${issueNumber}`
        ) as {
          number: number;
          title: string;
          body?: string;
          labels: Array<{ name: string }>;
          html_url: string;
        };

        // Fetch issue comments for more context
        const comments = await githubFetch(
          config.token,
          `/repos/${config.repo}/issues/${issueNumber}/comments`
        ) as Array<{ body: string; user: { login: string } }>;

        // Build context for the AI investigation
        const issueContext = `
# GitHub Issue #${issue.number}: ${issue.title}

${issue.body || 'No description provided.'}

${comments.length > 0 ? `## Comments (${comments.length}):
${comments.map(c => `**${c.user.login}:** ${c.body}`).join('\n\n')}` : ''}

**Labels:** ${issue.labels.map(l => l.name).join(', ') || 'None'}
**URL:** ${issue.html_url}
`;

        // Send progress update: analyzing
        mainWindow.webContents.send(
          IPC_CHANNELS.GITHUB_INVESTIGATION_PROGRESS,
          projectId,
          {
            phase: 'analyzing',
            issueNumber,
            progress: 30,
            message: 'AI is analyzing the issue...'
          } as GitHubInvestigationStatus
        );

        // Build task description
        const taskDescription = `Investigate GitHub Issue #${issue.number}: ${issue.title}

${issueContext}

Please analyze this issue and provide:
1. A brief summary of what the issue is about
2. A proposed solution approach
3. The files that would likely need to be modified
4. Estimated complexity (simple/standard/complex)
5. Acceptance criteria for resolving this issue`;

        // Create a spec for this investigation
        const taskId = `github-${issueNumber}-${Date.now()}`;

        // Start spec creation with the issue context
        agentManager.startSpecCreation(taskId, project.path, taskDescription);

        // Send progress update: creating task
        mainWindow.webContents.send(
          IPC_CHANNELS.GITHUB_INVESTIGATION_PROGRESS,
          projectId,
          {
            phase: 'creating_task',
            issueNumber,
            progress: 70,
            message: 'Creating task from investigation...'
          } as GitHubInvestigationStatus
        );

        const investigationResult: GitHubInvestigationResult = {
          success: true,
          issueNumber,
          analysis: {
            summary: `Investigation of issue #${issueNumber}: ${issue.title}`,
            proposedSolution: 'Task has been created for AI agent to implement the solution.',
            affectedFiles: [],
            estimatedComplexity: 'standard',
            acceptanceCriteria: [
              `Issue #${issueNumber} requirements are met`,
              'All existing tests pass',
              'New functionality is tested'
            ]
          },
          taskId
        };

        // Send completion
        mainWindow.webContents.send(
          IPC_CHANNELS.GITHUB_INVESTIGATION_PROGRESS,
          projectId,
          {
            phase: 'complete',
            issueNumber,
            progress: 100,
            message: 'Investigation complete!'
          } as GitHubInvestigationStatus
        );

        mainWindow.webContents.send(
          IPC_CHANNELS.GITHUB_INVESTIGATION_COMPLETE,
          projectId,
          investigationResult
        );

      } catch (error) {
        mainWindow.webContents.send(
          IPC_CHANNELS.GITHUB_INVESTIGATION_ERROR,
          projectId,
          error instanceof Error ? error.message : 'Failed to investigate issue'
        );
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.GITHUB_IMPORT_ISSUES,
    async (_, projectId: string, issueNumbers: number[]): Promise<IPCResult<GitHubImportResult>> => {
      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }

      const config = getGitHubConfig(project);
      if (!config) {
        return { success: false, error: 'No GitHub token or repository configured' };
      }

      let imported = 0;
      let failed = 0;
      const errors: string[] = [];
      const tasks: Task[] = [];

      for (const issueNumber of issueNumbers) {
        try {
          const issue = await githubFetch(
            config.token,
            `/repos/${config.repo}/issues/${issueNumber}`
          ) as {
            number: number;
            title: string;
            body?: string;
            labels: Array<{ name: string }>;
            html_url: string;
          };

          const labels = issue.labels.map(l => l.name).join(', ');
          const description = `# ${issue.title}

**GitHub Issue:** [#${issue.number}](${issue.html_url})
${labels ? `**Labels:** ${labels}` : ''}

## Description

${issue.body || 'No description provided.'}
`;

          const taskId = `github-${issueNumber}-${Date.now()}`;
          agentManager.startSpecCreation(taskId, project.path, description);
          imported++;
        } catch (err) {
          failed++;
          errors.push(`Failed to import #${issueNumber}: ${err instanceof Error ? err.message : 'Unknown error'}`);
        }
      }

      return {
        success: true,
        data: {
          success: failed === 0,
          imported,
          failed,
          errors: errors.length > 0 ? errors : undefined,
          tasks
        }
      };
    }
  );

  // ============================================
  // Auto Claude Source Update Operations
  // ============================================

  ipcMain.handle(
    IPC_CHANNELS.AUTOBUILD_SOURCE_CHECK,
    async (): Promise<IPCResult<{ updateAvailable: boolean; currentVersion: string; latestVersion?: string; releaseNotes?: string; error?: string }>> => {
      try {
        const result = await checkSourceUpdates();
        return { success: true, data: result };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to check for updates'
        };
      }
    }
  );

  ipcMain.on(
    IPC_CHANNELS.AUTOBUILD_SOURCE_DOWNLOAD,
    () => {
      const mainWindow = getMainWindow();
      if (!mainWindow) return;

      // Start download in background
      downloadAndApplyUpdate((progress) => {
        mainWindow.webContents.send(
          IPC_CHANNELS.AUTOBUILD_SOURCE_PROGRESS,
          progress
        );
      }).then((result) => {
        if (result.success) {
          mainWindow.webContents.send(
            IPC_CHANNELS.AUTOBUILD_SOURCE_PROGRESS,
            {
              stage: 'complete',
              message: `Updated to version ${result.version}`
            } as AutoBuildSourceUpdateProgress
          );
        } else {
          mainWindow.webContents.send(
            IPC_CHANNELS.AUTOBUILD_SOURCE_PROGRESS,
            {
              stage: 'error',
              message: result.error || 'Update failed'
            } as AutoBuildSourceUpdateProgress
          );
        }
      }).catch((error) => {
        mainWindow.webContents.send(
          IPC_CHANNELS.AUTOBUILD_SOURCE_PROGRESS,
          {
            stage: 'error',
            message: error instanceof Error ? error.message : 'Update failed'
          } as AutoBuildSourceUpdateProgress
        );
      });

      // Send initial progress
      mainWindow.webContents.send(
        IPC_CHANNELS.AUTOBUILD_SOURCE_PROGRESS,
        {
          stage: 'checking',
          message: 'Starting update...'
        } as AutoBuildSourceUpdateProgress
      );
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.AUTOBUILD_SOURCE_VERSION,
    async (): Promise<IPCResult<string>> => {
      try {
        const version = getBundledVersion();
        return { success: true, data: version };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get version'
        };
      }
    }
  );

  // ============================================
  // Auto Claude Source Environment Operations
  // ============================================

  /**
   * Parse an .env file content into a key-value object
   */
  const parseSourceEnvFile = (content: string): Record<string, string> => {
    const vars: Record<string, string> = {};
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const eqIndex = trimmed.indexOf('=');
      if (eqIndex > 0) {
        const key = trimmed.substring(0, eqIndex).trim();
        let value = trimmed.substring(eqIndex + 1).trim();
        // Remove quotes if present
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        vars[key] = value;
      }
    }
    return vars;
  };

  ipcMain.handle(
    IPC_CHANNELS.AUTOBUILD_SOURCE_ENV_GET,
    async (): Promise<IPCResult<SourceEnvConfig>> => {
      try {
        const sourcePath = getEffectiveSourcePath();
        if (!sourcePath) {
          return {
            success: true,
            data: {
              hasClaudeToken: false,
              envExists: false,
              sourcePath: undefined
            }
          };
        }

        const envPath = path.join(sourcePath, '.env');
        const envExists = existsSync(envPath);

        if (!envExists) {
          return {
            success: true,
            data: {
              hasClaudeToken: false,
              envExists: false,
              sourcePath
            }
          };
        }

        const content = readFileSync(envPath, 'utf-8');
        const vars = parseSourceEnvFile(content);
        const hasToken = !!vars['CLAUDE_CODE_OAUTH_TOKEN'];

        return {
          success: true,
          data: {
            hasClaudeToken: hasToken,
            claudeOAuthToken: hasToken ? vars['CLAUDE_CODE_OAUTH_TOKEN'] : undefined,
            envExists: true,
            sourcePath
          }
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get source env'
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.AUTOBUILD_SOURCE_ENV_UPDATE,
    async (_, config: { claudeOAuthToken?: string }): Promise<IPCResult> => {
      try {
        const sourcePath = getEffectiveSourcePath();
        if (!sourcePath) {
          return {
            success: false,
            error: 'Auto-Claude source path not found. Please configure it in App Settings.'
          };
        }

        const envPath = path.join(sourcePath, '.env');

        // Read existing content or start fresh
        let existingContent = '';
        const existingVars: Record<string, string> = {};

        if (existsSync(envPath)) {
          existingContent = readFileSync(envPath, 'utf-8');
          Object.assign(existingVars, parseSourceEnvFile(existingContent));
        }

        // Update the token
        if (config.claudeOAuthToken !== undefined) {
          existingVars['CLAUDE_CODE_OAUTH_TOKEN'] = config.claudeOAuthToken;
        }

        // Rebuild the .env file preserving comments and structure
        const lines = existingContent.split('\n');
        const processedKeys = new Set<string>();
        const outputLines: string[] = [];

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) {
            outputLines.push(line);
            continue;
          }

          const eqIndex = trimmed.indexOf('=');
          if (eqIndex > 0) {
            const key = trimmed.substring(0, eqIndex).trim();
            if (key in existingVars) {
              outputLines.push(`${key}=${existingVars[key]}`);
              processedKeys.add(key);
            } else {
              outputLines.push(line);
            }
          } else {
            outputLines.push(line);
          }
        }

        // Add any new keys that weren't in the original file
        for (const [key, value] of Object.entries(existingVars)) {
          if (!processedKeys.has(key)) {
            outputLines.push(`${key}=${value}`);
          }
        }

        writeFileSync(envPath, outputLines.join('\n'));

        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to update source env'
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.AUTOBUILD_SOURCE_ENV_CHECK_TOKEN,
    async (): Promise<IPCResult<SourceEnvCheckResult>> => {
      try {
        const sourcePath = getEffectiveSourcePath();
        if (!sourcePath) {
          return {
            success: true,
            data: {
              hasToken: false,
              sourcePath: undefined,
              error: 'Auto-Claude source path not found'
            }
          };
        }

        const envPath = path.join(sourcePath, '.env');
        if (!existsSync(envPath)) {
          return {
            success: true,
            data: {
              hasToken: false,
              sourcePath,
              error: '.env file does not exist'
            }
          };
        }

        const content = readFileSync(envPath, 'utf-8');
        const vars = parseSourceEnvFile(content);
        const hasToken = !!vars['CLAUDE_CODE_OAUTH_TOKEN'] && vars['CLAUDE_CODE_OAUTH_TOKEN'].length > 0;

        return {
          success: true,
          data: {
            hasToken,
            sourcePath
          }
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to check source token'
        };
      }
    }
  );

  // ============================================
  // Ideation Operations
  // ============================================

  ipcMain.handle(
    IPC_CHANNELS.IDEATION_GET,
    async (_, projectId: string): Promise<IPCResult<IdeationSession | null>> => {
      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }

      const ideationPath = path.join(
        project.path,
        AUTO_BUILD_PATHS.IDEATION_DIR,
        AUTO_BUILD_PATHS.IDEATION_FILE
      );

      if (!existsSync(ideationPath)) {
        return { success: true, data: null };
      }

      try {
        const content = readFileSync(ideationPath, 'utf-8');
        const rawIdeation = JSON.parse(content);

        // Transform snake_case to camelCase for frontend
        const session: IdeationSession = {
          id: rawIdeation.id || `ideation-${Date.now()}`,
          projectId,
          config: {
            enabledTypes: rawIdeation.config?.enabled_types || rawIdeation.config?.enabledTypes || [],
            includeRoadmapContext: rawIdeation.config?.include_roadmap_context ?? rawIdeation.config?.includeRoadmapContext ?? true,
            includeKanbanContext: rawIdeation.config?.include_kanban_context ?? rawIdeation.config?.includeKanbanContext ?? true,
            maxIdeasPerType: rawIdeation.config?.max_ideas_per_type || rawIdeation.config?.maxIdeasPerType || 5
          },
          ideas: (rawIdeation.ideas || []).map((idea: Record<string, unknown>) => {
            const base = {
              id: idea.id as string,
              type: idea.type as string,
              title: idea.title as string,
              description: idea.description as string,
              rationale: idea.rationale as string,
              status: idea.status as string || 'draft',
              createdAt: idea.created_at ? new Date(idea.created_at as string) : new Date()
            };

            // Type-specific fields
            if (idea.type === 'low_hanging_fruit') {
              return {
                ...base,
                buildsUpon: idea.builds_upon || idea.buildsUpon || [],
                estimatedEffort: idea.estimated_effort || idea.estimatedEffort || 'small',
                affectedFiles: idea.affected_files || idea.affectedFiles || [],
                existingPatterns: idea.existing_patterns || idea.existingPatterns || []
              };
            } else if (idea.type === 'ui_ux_improvements') {
              return {
                ...base,
                category: idea.category || 'usability',
                affectedComponents: idea.affected_components || idea.affectedComponents || [],
                screenshots: idea.screenshots || [],
                currentState: idea.current_state || idea.currentState || '',
                proposedChange: idea.proposed_change || idea.proposedChange || '',
                userBenefit: idea.user_benefit || idea.userBenefit || ''
              };
            } else if (idea.type === 'high_value_features') {
              return {
                ...base,
                targetAudience: idea.target_audience || idea.targetAudience || '',
                problemSolved: idea.problem_solved || idea.problemSolved || '',
                valueProposition: idea.value_proposition || idea.valueProposition || '',
                competitiveAdvantage: idea.competitive_advantage || idea.competitiveAdvantage,
                estimatedImpact: idea.estimated_impact || idea.estimatedImpact || 'medium',
                complexity: idea.complexity || 'medium',
                dependencies: idea.dependencies || [],
                acceptanceCriteria: idea.acceptance_criteria || idea.acceptanceCriteria || []
              };
            }

            return base;
          }),
          projectContext: {
            existingFeatures: rawIdeation.project_context?.existing_features || rawIdeation.projectContext?.existingFeatures || [],
            techStack: rawIdeation.project_context?.tech_stack || rawIdeation.projectContext?.techStack || [],
            targetAudience: rawIdeation.project_context?.target_audience || rawIdeation.projectContext?.targetAudience,
            plannedFeatures: rawIdeation.project_context?.planned_features || rawIdeation.projectContext?.plannedFeatures || []
          },
          generatedAt: rawIdeation.generated_at ? new Date(rawIdeation.generated_at) : new Date(),
          updatedAt: rawIdeation.updated_at ? new Date(rawIdeation.updated_at) : new Date()
        };

        return { success: true, data: session };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to read ideation'
        };
      }
    }
  );

  ipcMain.on(
    IPC_CHANNELS.IDEATION_GENERATE,
    (_, projectId: string, config: IdeationConfig) => {
      const mainWindow = getMainWindow();
      if (!mainWindow) return;

      const project = projectStore.getProject(projectId);
      if (!project) {
        mainWindow.webContents.send(
          IPC_CHANNELS.IDEATION_ERROR,
          projectId,
          'Project not found'
        );
        return;
      }

      // Start ideation generation via agent manager
      agentManager.startIdeationGeneration(projectId, project.path, config, false);

      // Send initial progress
      mainWindow.webContents.send(
        IPC_CHANNELS.IDEATION_PROGRESS,
        projectId,
        {
          phase: 'analyzing',
          progress: 10,
          message: 'Analyzing project structure...'
        } as IdeationGenerationStatus
      );
    }
  );

  ipcMain.on(
    IPC_CHANNELS.IDEATION_REFRESH,
    (_, projectId: string, config: IdeationConfig) => {
      const mainWindow = getMainWindow();
      if (!mainWindow) return;

      const project = projectStore.getProject(projectId);
      if (!project) {
        mainWindow.webContents.send(
          IPC_CHANNELS.IDEATION_ERROR,
          projectId,
          'Project not found'
        );
        return;
      }

      // Start ideation regeneration with refresh flag
      agentManager.startIdeationGeneration(projectId, project.path, config, true);

      // Send initial progress
      mainWindow.webContents.send(
        IPC_CHANNELS.IDEATION_PROGRESS,
        projectId,
        {
          phase: 'analyzing',
          progress: 10,
          message: 'Refreshing ideation...'
        } as IdeationGenerationStatus
      );
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.IDEATION_UPDATE_IDEA,
    async (
      _,
      projectId: string,
      ideaId: string,
      status: IdeationStatus
    ): Promise<IPCResult> => {
      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }

      const ideationPath = path.join(
        project.path,
        AUTO_BUILD_PATHS.IDEATION_DIR,
        AUTO_BUILD_PATHS.IDEATION_FILE
      );

      if (!existsSync(ideationPath)) {
        return { success: false, error: 'Ideation not found' };
      }

      try {
        const content = readFileSync(ideationPath, 'utf-8');
        const ideation = JSON.parse(content);

        // Find and update the idea
        const idea = ideation.ideas?.find((i: { id: string }) => i.id === ideaId);
        if (!idea) {
          return { success: false, error: 'Idea not found' };
        }

        idea.status = status;
        ideation.updated_at = new Date().toISOString();

        writeFileSync(ideationPath, JSON.stringify(ideation, null, 2));

        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to update idea'
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.IDEATION_DISMISS,
    async (_, projectId: string, ideaId: string): Promise<IPCResult> => {
      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }

      const ideationPath = path.join(
        project.path,
        AUTO_BUILD_PATHS.IDEATION_DIR,
        AUTO_BUILD_PATHS.IDEATION_FILE
      );

      if (!existsSync(ideationPath)) {
        return { success: false, error: 'Ideation not found' };
      }

      try {
        const content = readFileSync(ideationPath, 'utf-8');
        const ideation = JSON.parse(content);

        // Find and dismiss the idea
        const idea = ideation.ideas?.find((i: { id: string }) => i.id === ideaId);
        if (!idea) {
          return { success: false, error: 'Idea not found' };
        }

        idea.status = 'dismissed';
        ideation.updated_at = new Date().toISOString();

        writeFileSync(ideationPath, JSON.stringify(ideation, null, 2));

        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to dismiss idea'
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.IDEATION_CONVERT_TO_TASK,
    async (_, projectId: string, ideaId: string): Promise<IPCResult<Task>> => {
      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }

      const ideationPath = path.join(
        project.path,
        AUTO_BUILD_PATHS.IDEATION_DIR,
        AUTO_BUILD_PATHS.IDEATION_FILE
      );

      if (!existsSync(ideationPath)) {
        return { success: false, error: 'Ideation not found' };
      }

      try {
        const content = readFileSync(ideationPath, 'utf-8');
        const ideation = JSON.parse(content);

        // Find the idea
        const idea = ideation.ideas?.find((i: { id: string }) => i.id === ideaId);
        if (!idea) {
          return { success: false, error: 'Idea not found' };
        }

        // Generate task ID
        const taskId = `task-${Date.now()}`;

        // Build task description based on idea type
        let taskDescription = `# ${idea.title}\n\n`;
        taskDescription += `${idea.description}\n\n`;
        taskDescription += `## Rationale\n${idea.rationale}\n\n`;

        if (idea.type === 'low_hanging_fruit') {
          if (idea.builds_upon?.length) {
            taskDescription += `## Builds Upon\n${idea.builds_upon.map((b: string) => `- ${b}`).join('\n')}\n\n`;
          }
          if (idea.affected_files?.length) {
            taskDescription += `## Affected Files\n${idea.affected_files.map((f: string) => `- ${f}`).join('\n')}\n\n`;
          }
          if (idea.existing_patterns?.length) {
            taskDescription += `## Patterns to Follow\n${idea.existing_patterns.map((p: string) => `- ${p}`).join('\n')}\n\n`;
          }
        } else if (idea.type === 'ui_ux_improvements') {
          taskDescription += `## Category\n${idea.category}\n\n`;
          taskDescription += `## Current State\n${idea.current_state}\n\n`;
          taskDescription += `## Proposed Change\n${idea.proposed_change}\n\n`;
          taskDescription += `## User Benefit\n${idea.user_benefit}\n\n`;
          if (idea.affected_components?.length) {
            taskDescription += `## Affected Components\n${idea.affected_components.map((c: string) => `- ${c}`).join('\n')}\n\n`;
          }
        } else if (idea.type === 'high_value_features') {
          taskDescription += `## Target Audience\n${idea.target_audience}\n\n`;
          taskDescription += `## Problem Solved\n${idea.problem_solved}\n\n`;
          taskDescription += `## Value Proposition\n${idea.value_proposition}\n\n`;
          if (idea.competitive_advantage) {
            taskDescription += `## Competitive Advantage\n${idea.competitive_advantage}\n\n`;
          }
          if (idea.acceptance_criteria?.length) {
            taskDescription += `## Acceptance Criteria\n${idea.acceptance_criteria.map((c: string) => `- ${c}`).join('\n')}\n\n`;
          }
          if (idea.dependencies?.length) {
            taskDescription += `## Dependencies\n${idea.dependencies.map((d: string) => `- ${d}`).join('\n')}\n\n`;
          }
        }

        // Start spec creation
        agentManager.startSpecCreation(taskId, project.path, taskDescription);

        // Update idea with converted status
        idea.status = 'converted';
        idea.linked_task_id = taskId;
        ideation.updated_at = new Date().toISOString();
        writeFileSync(ideationPath, JSON.stringify(ideation, null, 2));

        // Create placeholder task
        const task: Task = {
          id: taskId,
          specId: '',
          projectId,
          title: idea.title,
          description: taskDescription,
          status: 'backlog',
          chunks: [],
          logs: [],
          createdAt: new Date(),
          updatedAt: new Date()
        };

        return { success: true, data: task };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to convert idea to task'
        };
      }
    }
  );

  // ============================================
  // Ideation Agent Events → Renderer
  // ============================================

  agentManager.on('ideation-progress', (projectId: string, status: IdeationGenerationStatus) => {
    const mainWindow = getMainWindow();
    if (mainWindow) {
      mainWindow.webContents.send(IPC_CHANNELS.IDEATION_PROGRESS, projectId, status);
    }
  });

  agentManager.on('ideation-log', (projectId: string, log: string) => {
    const mainWindow = getMainWindow();
    if (mainWindow) {
      mainWindow.webContents.send(IPC_CHANNELS.IDEATION_LOG, projectId, log);
    }
  });

  agentManager.on('ideation-complete', (projectId: string, session: IdeationSession) => {
    const mainWindow = getMainWindow();
    if (mainWindow) {
      mainWindow.webContents.send(IPC_CHANNELS.IDEATION_COMPLETE, projectId, session);
    }
  });

  agentManager.on('ideation-error', (projectId: string, error: string) => {
    const mainWindow = getMainWindow();
    if (mainWindow) {
      mainWindow.webContents.send(IPC_CHANNELS.IDEATION_ERROR, projectId, error);
    }
  });

  // ============================================
  // Changelog Operations
  // ============================================

  ipcMain.handle(
    IPC_CHANNELS.CHANGELOG_GET_DONE_TASKS,
    async (_, projectId: string): Promise<IPCResult<import('../shared/types').ChangelogTask[]>> => {
      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }

      const tasks = projectStore.getTasks(projectId);
      const doneTasks = changelogService.getCompletedTasks(project.path, tasks);

      return { success: true, data: doneTasks };
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.CHANGELOG_LOAD_TASK_SPECS,
    async (_, projectId: string, taskIds: string[]): Promise<IPCResult<import('../shared/types').TaskSpecContent[]>> => {
      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }

      const tasks = projectStore.getTasks(projectId);
      const specs = await changelogService.loadTaskSpecs(project.path, taskIds, tasks);

      return { success: true, data: specs };
    }
  );

  ipcMain.on(
    IPC_CHANNELS.CHANGELOG_GENERATE,
    async (_, request: import('../shared/types').ChangelogGenerationRequest) => {
      const mainWindow = getMainWindow();
      if (!mainWindow) return;

      const project = projectStore.getProject(request.projectId);
      if (!project) {
        mainWindow.webContents.send(
          IPC_CHANNELS.CHANGELOG_GENERATION_ERROR,
          request.projectId,
          'Project not found'
        );
        return;
      }

      // Load specs for selected tasks
      const tasks = projectStore.getTasks(request.projectId);
      const specs = await changelogService.loadTaskSpecs(project.path, request.taskIds, tasks);

      // Start generation
      changelogService.generateChangelog(request.projectId, project.path, request, specs);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.CHANGELOG_SAVE,
    async (_, request: import('../shared/types').ChangelogSaveRequest): Promise<IPCResult<import('../shared/types').ChangelogSaveResult>> => {
      const project = projectStore.getProject(request.projectId);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }

      try {
        const result = changelogService.saveChangelog(project.path, request);
        return { success: true, data: result };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to save changelog'
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.CHANGELOG_READ_EXISTING,
    async (_, projectId: string): Promise<IPCResult<import('../shared/types').ExistingChangelog>> => {
      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }

      const result = changelogService.readExistingChangelog(project.path);
      return { success: true, data: result };
    }
  );

  // ============================================
  // Changelog Agent Events → Renderer
  // ============================================

  changelogService.on('generation-progress', (projectId: string, progress: import('../shared/types').ChangelogGenerationProgress) => {
    const mainWindow = getMainWindow();
    if (mainWindow) {
      mainWindow.webContents.send(IPC_CHANNELS.CHANGELOG_GENERATION_PROGRESS, projectId, progress);
    }
  });

  changelogService.on('generation-complete', (projectId: string, result: import('../shared/types').ChangelogGenerationResult) => {
    const mainWindow = getMainWindow();
    if (mainWindow) {
      mainWindow.webContents.send(IPC_CHANNELS.CHANGELOG_GENERATION_COMPLETE, projectId, result);
    }
  });

  changelogService.on('generation-error', (projectId: string, error: string) => {
    const mainWindow = getMainWindow();
    if (mainWindow) {
      mainWindow.webContents.send(IPC_CHANNELS.CHANGELOG_GENERATION_ERROR, projectId, error);
    }
  });
}
