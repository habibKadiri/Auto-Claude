import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import path from 'path';
import { existsSync, readFileSync } from 'fs';
import { app } from 'electron';

interface AgentProcess {
  taskId: string;
  process: ChildProcess;
  startedAt: Date;
}

export interface AgentManagerEvents {
  log: (taskId: string, log: string) => void;
  error: (taskId: string, error: string) => void;
  exit: (taskId: string, code: number | null) => void;
}

/**
 * Manages Python subprocess spawning for auto-claude agents
 */
export class AgentManager extends EventEmitter {
  private processes: Map<string, AgentProcess> = new Map();
  private pythonPath: string = 'python3';
  private autoBuildSourcePath: string = ''; // Source auto-claude repo location

  constructor() {
    super();
  }

  /**
   * Configure paths for Python and auto-claude source
   */
  configure(pythonPath?: string, autoBuildSourcePath?: string): void {
    if (pythonPath) {
      this.pythonPath = pythonPath;
    }
    if (autoBuildSourcePath) {
      this.autoBuildSourcePath = autoBuildSourcePath;
    }
  }

  /**
   * Get the auto-claude source path (detects automatically if not configured)
   */
  private getAutoBuildSourcePath(): string | null {
    // If manually configured, use that
    if (this.autoBuildSourcePath && existsSync(this.autoBuildSourcePath)) {
      return this.autoBuildSourcePath;
    }

    // Auto-detect from app location
    const possiblePaths = [
      // Dev mode: from dist/main -> ../../auto-claude (sibling to auto-claude-ui)
      path.resolve(__dirname, '..', '..', '..', 'auto-claude'),
      // Alternative: from app root
      path.resolve(app.getAppPath(), '..', 'auto-claude'),
      // If running from repo root
      path.resolve(process.cwd(), 'auto-claude')
    ];

    for (const p of possiblePaths) {
      if (existsSync(p) && existsSync(path.join(p, 'VERSION'))) {
        return p;
      }
    }
    return null;
  }

  /**
   * Load environment variables from auto-claude .env file
   */
  private loadAutoBuildEnv(): Record<string, string> {
    const autoBuildSource = this.getAutoBuildSourcePath();
    if (!autoBuildSource) {
      console.log('[loadAutoBuildEnv] No auto-build source path found');
      return {};
    }

    const envPath = path.join(autoBuildSource, '.env');
    console.log('[loadAutoBuildEnv] Looking for .env at:', envPath);
    if (!existsSync(envPath)) {
      console.log('[loadAutoBuildEnv] .env file does not exist');
      return {};
    }

    try {
      const envContent = readFileSync(envPath, 'utf-8');
      const envVars: Record<string, string> = {};

      for (const line of envContent.split('\n')) {
        const trimmed = line.trim();
        // Skip comments and empty lines
        if (!trimmed || trimmed.startsWith('#')) {
          continue;
        }

        const eqIndex = trimmed.indexOf('=');
        if (eqIndex > 0) {
          const key = trimmed.substring(0, eqIndex).trim();
          let value = trimmed.substring(eqIndex + 1).trim();

          // Remove quotes if present
          if ((value.startsWith('"') && value.endsWith('"')) ||
              (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
          }

          envVars[key] = value;
        }
      }

      return envVars;
    } catch {
      return {};
    }
  }

  /**
   * Start spec creation process
   */
  startSpecCreation(
    taskId: string,
    projectPath: string,
    taskDescription: string
  ): void {
    const autoBuildDir = path.join(projectPath, 'auto-claude');
    const specRunnerPath = path.join(autoBuildDir, 'spec_runner.py');

    const args = [specRunnerPath, '--task', taskDescription];

    this.spawnProcess(taskId, projectPath, args);
  }

  /**
   * Start task execution (run.py)
   */
  startTaskExecution(
    taskId: string,
    projectPath: string,
    specId: string,
    options: { parallel?: boolean; workers?: number } = {}
  ): void {
    const autoBuildDir = path.join(projectPath, 'auto-claude');
    const runPath = path.join(autoBuildDir, 'run.py');

    const args = [runPath, '--spec', specId];

    if (options.parallel && options.workers) {
      args.push('--parallel', options.workers.toString());
    }

    this.spawnProcess(taskId, projectPath, args);
  }

  /**
   * Start QA process
   */
  startQAProcess(
    taskId: string,
    projectPath: string,
    specId: string
  ): void {
    const autoBuildDir = path.join(projectPath, 'auto-claude');
    const runPath = path.join(autoBuildDir, 'run.py');

    const args = [runPath, '--spec', specId, '--qa'];

    this.spawnProcess(taskId, projectPath, args);
  }

  /**
   * Start roadmap generation process
   */
  startRoadmapGeneration(
    projectId: string,
    projectPath: string,
    refresh: boolean = false
  ): void {
    // Use source auto-claude path (the repo), not the project's auto-claude
    const autoBuildSource = this.getAutoBuildSourcePath();

    if (!autoBuildSource) {
      this.emit('roadmap-error', projectId, 'Auto-build source path not found. Please configure it in App Settings.');
      return;
    }

    const roadmapRunnerPath = path.join(autoBuildSource, 'roadmap_runner.py');

    if (!existsSync(roadmapRunnerPath)) {
      this.emit('roadmap-error', projectId, `Roadmap runner not found at: ${roadmapRunnerPath}`);
      return;
    }

    const args = [roadmapRunnerPath, '--project', projectPath];

    if (refresh) {
      args.push('--refresh');
    }

    // Use projectId as taskId for roadmap operations
    this.spawnRoadmapProcess(projectId, projectPath, args);
  }

  /**
   * Start ideation generation process
   */
  startIdeationGeneration(
    projectId: string,
    projectPath: string,
    config: {
      enabledTypes: string[];
      includeRoadmapContext: boolean;
      includeKanbanContext: boolean;
      maxIdeasPerType: number;
    },
    refresh: boolean = false
  ): void {
    // Use source auto-claude path (the repo), not the project's auto-claude
    const autoBuildSource = this.getAutoBuildSourcePath();

    if (!autoBuildSource) {
      this.emit('ideation-error', projectId, 'Auto-build source path not found. Please configure it in App Settings.');
      return;
    }

    const ideationRunnerPath = path.join(autoBuildSource, 'ideation_runner.py');

    if (!existsSync(ideationRunnerPath)) {
      this.emit('ideation-error', projectId, `Ideation runner not found at: ${ideationRunnerPath}`);
      return;
    }

    const args = [ideationRunnerPath, '--project', projectPath];

    // Add enabled types as comma-separated list
    if (config.enabledTypes.length > 0) {
      args.push('--types', config.enabledTypes.join(','));
    }

    // Add context flags (script uses --no-roadmap/--no-kanban negative flags)
    if (!config.includeRoadmapContext) {
      args.push('--no-roadmap');
    }
    if (!config.includeKanbanContext) {
      args.push('--no-kanban');
    }

    // Add max ideas per type
    if (config.maxIdeasPerType) {
      args.push('--max-ideas', config.maxIdeasPerType.toString());
    }

    if (refresh) {
      args.push('--refresh');
    }

    // Use projectId as taskId for ideation operations
    this.spawnIdeationProcess(projectId, projectPath, args);
  }

  /**
   * Spawn a Python process for ideation generation
   */
  private spawnIdeationProcess(
    projectId: string,
    _projectPath: string,
    args: string[]
  ): void {
    // Kill existing process for this project if any
    this.killTask(projectId);

    // Run from auto-claude source directory so imports work correctly
    const autoBuildSource = this.getAutoBuildSourcePath();
    const cwd = autoBuildSource || process.cwd();

    // Load environment variables from auto-claude .env file
    const autoBuildEnv = this.loadAutoBuildEnv();

    const childProcess = spawn(this.pythonPath, args, {
      cwd,
      env: {
        ...process.env,
        ...autoBuildEnv, // Include auto-claude .env variables (like CLAUDE_CODE_OAUTH_TOKEN)
        PYTHONUNBUFFERED: '1'
      }
    });

    this.processes.set(projectId, {
      taskId: projectId,
      process: childProcess,
      startedAt: new Date()
    });

    // Track progress through output
    let progressPhase = 'analyzing';
    let progressPercent = 10;

    // Helper to emit logs - split multi-line output into individual log lines
    const emitLogs = (log: string) => {
      const lines = log.split('\n').filter(line => line.trim().length > 0);
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length > 0) {
          console.log('[Ideation]', trimmed);
          this.emit('ideation-log', projectId, trimmed);
        }
      }
    };

    console.log('[Ideation] Starting ideation process with args:', args);
    console.log('[Ideation] CWD:', cwd);
    console.log('[Ideation] Python path:', this.pythonPath);
    console.log('[Ideation] Env vars loaded:', Object.keys(autoBuildEnv));
    console.log('[Ideation] Has CLAUDE_CODE_OAUTH_TOKEN:', !!autoBuildEnv['CLAUDE_CODE_OAUTH_TOKEN']);

    // Handle stdout
    childProcess.stdout?.on('data', (data: Buffer) => {
      const log = data.toString();

      // Emit all log lines for the activity log
      emitLogs(log);

      // Parse progress from output - track phase transitions
      if (log.includes('PROJECT INDEX') || log.includes('PROJECT ANALYSIS')) {
        progressPhase = 'analyzing';
        progressPercent = 15;
      } else if (log.includes('CONTEXT GATHERING')) {
        progressPhase = 'discovering';
        progressPercent = 25;
      } else if (log.includes('LOW_HANGING_FRUIT') || log.includes('LOW-HANGING FRUIT')) {
        progressPhase = 'generating';
        progressPercent = 35;
      } else if (log.includes('UI_UX_IMPROVEMENTS') || log.includes('UI/UX')) {
        progressPhase = 'generating';
        progressPercent = 45;
      } else if (log.includes('HIGH_VALUE_FEATURES') || log.includes('HIGH VALUE') || log.includes('HIGH-VALUE')) {
        progressPhase = 'generating';
        progressPercent = 55;
      } else if (log.includes('DOCUMENTATION_GAPS') || log.includes('DOCUMENTATION')) {
        progressPhase = 'generating';
        progressPercent = 65;
      } else if (log.includes('SECURITY_HARDENING') || log.includes('SECURITY')) {
        progressPhase = 'generating';
        progressPercent = 75;
      } else if (log.includes('PERFORMANCE_OPTIMIZATIONS') || log.includes('PERFORMANCE')) {
        progressPhase = 'generating';
        progressPercent = 85;
      } else if (log.includes('MERGE') || log.includes('FINALIZE')) {
        progressPhase = 'generating';
        progressPercent = 92;
      } else if (log.includes('IDEATION COMPLETE')) {
        progressPhase = 'complete';
        progressPercent = 100;
      }

      // Emit progress update with a clean message for the status bar
      const statusMessage = log.trim().split('\n')[0].substring(0, 200);
      this.emit('ideation-progress', projectId, {
        phase: progressPhase,
        progress: progressPercent,
        message: statusMessage
      });
    });

    // Handle stderr - also emit as logs
    childProcess.stderr?.on('data', (data: Buffer) => {
      const log = data.toString();
      console.error('[Ideation STDERR]', log);
      emitLogs(log);
      this.emit('ideation-progress', projectId, {
        phase: progressPhase,
        progress: progressPercent,
        message: log.trim().split('\n')[0].substring(0, 200)
      });
    });

    // Handle process exit
    childProcess.on('exit', (code: number | null) => {
      console.log('[Ideation] Process exited with code:', code);
      this.processes.delete(projectId);

      if (code === 0) {
        this.emit('ideation-progress', projectId, {
          phase: 'complete',
          progress: 100,
          message: 'Ideation generation complete'
        });
      } else {
        this.emit('ideation-error', projectId, `Ideation generation failed with exit code ${code}`);
      }
    });

    // Handle process error
    childProcess.on('error', (err: Error) => {
      console.error('[Ideation] Process error:', err.message);
      this.processes.delete(projectId);
      this.emit('ideation-error', projectId, err.message);
    });
  }

  /**
   * Spawn a Python process for roadmap generation
   */
  private spawnRoadmapProcess(
    projectId: string,
    _projectPath: string,
    args: string[]
  ): void {
    // Kill existing process for this project if any
    this.killTask(projectId);

    // Run from auto-claude source directory so imports work correctly
    const autoBuildSource = this.getAutoBuildSourcePath();
    const cwd = autoBuildSource || process.cwd();

    // Load environment variables from auto-claude .env file
    const autoBuildEnv = this.loadAutoBuildEnv();

    const childProcess = spawn(this.pythonPath, args, {
      cwd,
      env: {
        ...process.env,
        ...autoBuildEnv, // Include auto-claude .env variables (like CLAUDE_CODE_OAUTH_TOKEN)
        PYTHONUNBUFFERED: '1'
      }
    });

    this.processes.set(projectId, {
      taskId: projectId,
      process: childProcess,
      startedAt: new Date()
    });

    // Track progress through output
    let progressPhase = 'analyzing';
    let progressPercent = 10;

    // Handle stdout
    childProcess.stdout?.on('data', (data: Buffer) => {
      const log = data.toString();

      // Parse progress from output
      if (log.includes('PROJECT ANALYSIS')) {
        progressPhase = 'analyzing';
        progressPercent = 20;
      } else if (log.includes('PROJECT DISCOVERY')) {
        progressPhase = 'discovering';
        progressPercent = 40;
      } else if (log.includes('FEATURE GENERATION')) {
        progressPhase = 'generating';
        progressPercent = 70;
      } else if (log.includes('ROADMAP GENERATED')) {
        progressPhase = 'complete';
        progressPercent = 100;
      }

      // Emit progress update
      this.emit('roadmap-progress', projectId, {
        phase: progressPhase,
        progress: progressPercent,
        message: log.trim().substring(0, 200) // Truncate long messages
      });
    });

    // Handle stderr
    childProcess.stderr?.on('data', (data: Buffer) => {
      const log = data.toString();
      this.emit('roadmap-progress', projectId, {
        phase: progressPhase,
        progress: progressPercent,
        message: log.trim().substring(0, 200)
      });
    });

    // Handle process exit
    childProcess.on('exit', (code: number | null) => {
      this.processes.delete(projectId);

      if (code === 0) {
        this.emit('roadmap-progress', projectId, {
          phase: 'complete',
          progress: 100,
          message: 'Roadmap generation complete'
        });
      } else {
        this.emit('roadmap-error', projectId, `Roadmap generation failed with exit code ${code}`);
      }
    });

    // Handle process error
    childProcess.on('error', (err: Error) => {
      this.processes.delete(projectId);
      this.emit('roadmap-error', projectId, err.message);
    });
  }

  /**
   * Spawn a Python process
   */
  private spawnProcess(
    taskId: string,
    cwd: string,
    args: string[]
  ): void {
    // Kill existing process for this task if any
    this.killTask(taskId);

    const childProcess = spawn(this.pythonPath, args, {
      cwd,
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1' // Ensure real-time output
      }
    });

    this.processes.set(taskId, {
      taskId,
      process: childProcess,
      startedAt: new Date()
    });

    // Handle stdout
    childProcess.stdout?.on('data', (data: Buffer) => {
      const log = data.toString();
      this.emit('log', taskId, log);
    });

    // Handle stderr
    childProcess.stderr?.on('data', (data: Buffer) => {
      const log = data.toString();
      // Some Python output goes to stderr (like progress bars)
      // so we treat it as log, not error
      this.emit('log', taskId, log);
    });

    // Handle process exit
    childProcess.on('exit', (code: number | null) => {
      this.processes.delete(taskId);
      this.emit('exit', taskId, code);
    });

    // Handle process error
    childProcess.on('error', (err: Error) => {
      this.processes.delete(taskId);
      this.emit('error', taskId, err.message);
    });
  }

  /**
   * Kill a specific task's process
   */
  killTask(taskId: string): boolean {
    const agentProcess = this.processes.get(taskId);
    if (agentProcess) {
      try {
        // Send SIGTERM first for graceful shutdown
        agentProcess.process.kill('SIGTERM');

        // Force kill after timeout
        setTimeout(() => {
          if (!agentProcess.process.killed) {
            agentProcess.process.kill('SIGKILL');
          }
        }, 5000);

        this.processes.delete(taskId);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  /**
   * Kill all running processes
   */
  async killAll(): Promise<void> {
    const killPromises = Array.from(this.processes.keys()).map((taskId) => {
      return new Promise<void>((resolve) => {
        this.killTask(taskId);
        resolve();
      });
    });
    await Promise.all(killPromises);
  }

  /**
   * Check if a task is running
   */
  isRunning(taskId: string): boolean {
    return this.processes.has(taskId);
  }

  /**
   * Get all running task IDs
   */
  getRunningTasks(): string[] {
    return Array.from(this.processes.keys());
  }
}
