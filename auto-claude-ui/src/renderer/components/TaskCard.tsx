import { useState, useEffect, useMemo } from 'react';
import { Play, Square, Clock, Zap, Target, Shield, Gauge, Palette, FileCode, Bug, Wrench, Loader2, AlertTriangle, RotateCcw, ChevronRight, Image as ImageIcon } from 'lucide-react';
import { Card, CardContent } from './ui/card';
import { Badge } from './ui/badge';
import { Progress } from './ui/progress';
import { Button } from './ui/button';
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from './ui/tooltip';
import { cn, calculateProgress, formatRelativeTime } from '../lib/utils';
import {
  CHUNK_STATUS_COLORS,
  TASK_CATEGORY_LABELS,
  TASK_CATEGORY_COLORS,
  TASK_COMPLEXITY_COLORS,
  TASK_COMPLEXITY_LABELS,
  TASK_IMPACT_COLORS,
  TASK_IMPACT_LABELS,
  TASK_PRIORITY_COLORS,
  TASK_PRIORITY_LABELS,
  EXECUTION_PHASE_LABELS,
  EXECUTION_PHASE_BADGE_COLORS
} from '../../shared/constants';
import { startTask, stopTask, checkTaskRunning, recoverStuckTask } from '../stores/task-store';
import type { Task, TaskCategory } from '../../shared/types';

// Category icon mapping
const CategoryIcon: Record<TaskCategory, typeof Zap> = {
  feature: Target,
  bug_fix: Bug,
  refactoring: Wrench,
  documentation: FileCode,
  security: Shield,
  performance: Gauge,
  ui_ux: Palette,
  infrastructure: Wrench,
  testing: FileCode
};

// Maximum number of visible badges before collapsing
const MAX_VISIBLE_BADGES = 3;

interface TaskCardProps {
  task: Task;
  onClick: () => void;
}

export function TaskCard({ task, onClick }: TaskCardProps) {
  const [isStuck, setIsStuck] = useState(false);
  const [isRecovering, setIsRecovering] = useState(false);
  const [hasCheckedRunning, setHasCheckedRunning] = useState(false);

  const progress = calculateProgress(task.chunks);
  const isRunning = task.status === 'in_progress';
  const executionPhase = task.executionProgress?.phase;
  const hasActiveExecution = executionPhase && executionPhase !== 'idle' && executionPhase !== 'complete' && executionPhase !== 'failed';
  const isDone = task.status === 'done';
  const needsReview = task.status === 'human_review';

  // Check if task is stuck (status says in_progress but no actual process)
  useEffect(() => {
    if (isRunning && !hasCheckedRunning) {
      checkTaskRunning(task.id).then((actuallyRunning) => {
        setIsStuck(!actuallyRunning);
        setHasCheckedRunning(true);
      });
    } else if (!isRunning) {
      setIsStuck(false);
      setHasCheckedRunning(false);
    }
  }, [task.id, isRunning, hasCheckedRunning]);

  // Collect all badges to display with priority ordering
  const badges = useMemo(() => {
    const result: Array<{ key: string; priority: number; element: JSX.Element }> = [];

    if (task.metadata) {
      // Category badge (highest priority - always show)
      if (task.metadata.category) {
        const Icon = CategoryIcon[task.metadata.category];
        result.push({
          key: 'category',
          priority: 1,
          element: (
            <Badge
              variant="outline"
              className={cn('text-[10px] px-1.5 py-0 flex items-center gap-0.5', TASK_CATEGORY_COLORS[task.metadata.category])}
            >
              {Icon && <Icon className="h-2.5 w-2.5" />}
              {TASK_CATEGORY_LABELS[task.metadata.category]}
            </Badge>
          )
        });
      }

      // Security severity (high priority)
      if (task.metadata.securitySeverity) {
        result.push({
          key: 'security',
          priority: 2,
          element: (
            <Badge
              variant="outline"
              className={cn('text-[10px] px-1.5 py-0', TASK_IMPACT_COLORS[task.metadata.securitySeverity])}
            >
              <Shield className="h-2.5 w-2.5 mr-0.5" />
              {task.metadata.securitySeverity}
            </Badge>
          )
        });
      }

      // Priority badge (urgent/high only)
      if (task.metadata.priority && (task.metadata.priority === 'urgent' || task.metadata.priority === 'high')) {
        result.push({
          key: 'priority',
          priority: 3,
          element: (
            <Badge
              variant="outline"
              className={cn('text-[10px] px-1.5 py-0', TASK_PRIORITY_COLORS[task.metadata.priority])}
            >
              {TASK_PRIORITY_LABELS[task.metadata.priority]}
            </Badge>
          )
        });
      }

      // Impact badge (high/critical only)
      if (task.metadata.impact && (task.metadata.impact === 'high' || task.metadata.impact === 'critical')) {
        result.push({
          key: 'impact',
          priority: 4,
          element: (
            <Badge
              variant="outline"
              className={cn('text-[10px] px-1.5 py-0', TASK_IMPACT_COLORS[task.metadata.impact])}
            >
              {TASK_IMPACT_LABELS[task.metadata.impact]}
            </Badge>
          )
        });
      }

      // Complexity badge
      if (task.metadata.complexity) {
        result.push({
          key: 'complexity',
          priority: 5,
          element: (
            <Badge
              variant="outline"
              className={cn('text-[10px] px-1.5 py-0', TASK_COMPLEXITY_COLORS[task.metadata.complexity])}
            >
              {TASK_COMPLEXITY_LABELS[task.metadata.complexity]}
            </Badge>
          )
        });
      }

      // Attached images indicator
      if (task.metadata.attachedImages && task.metadata.attachedImages.length > 0) {
        result.push({
          key: 'images',
          priority: 6,
          element: (
            <Badge
              variant="outline"
              className="text-[10px] px-1.5 py-0 bg-info/10 text-info border-info/30"
            >
              <ImageIcon className="h-2.5 w-2.5 mr-0.5" />
              {task.metadata.attachedImages.length}
            </Badge>
          )
        });
      }
    }

    return result.sort((a, b) => a.priority - b.priority);
  }, [task.metadata]);

  const visibleBadges = badges.slice(0, MAX_VISIBLE_BADGES);
  const hiddenBadges = badges.slice(MAX_VISIBLE_BADGES);

  const handleStartStop = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isRunning && !isStuck) {
      stopTask(task.id);
    } else {
      startTask(task.id);
    }
  };

  const handleRecover = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsRecovering(true);
    const result = await recoverStuckTask(task.id, 'backlog');
    if (result.success) {
      setIsStuck(false);
    }
    setIsRecovering(false);
  };

  const getStatusBadgeVariant = (status: string) => {
    switch (status) {
      case 'in_progress':
        return 'info';
      case 'ai_review':
        return 'warning';
      case 'human_review':
        return 'purple';
      case 'done':
        return 'success';
      default:
        return 'secondary';
    }
  };

  const getStatusLabel = (status: string) => {
    switch (status) {
      case 'in_progress':
        return 'Running';
      case 'ai_review':
        return 'AI Review';
      case 'human_review':
        return 'Needs Review';
      case 'done':
        return 'Complete';
      default:
        return 'Pending';
    }
  };

  // Determine progress bar color based on state
  const getProgressClassName = () => {
    if (hasActiveExecution) return 'progress-working';
    if (isDone) return '';
    return '';
  };

  return (
    <TooltipProvider delayDuration={300}>
      <Card
        className={cn(
          'card-surface task-card-glow cursor-pointer group overflow-hidden',
          isRunning && !isStuck && 'ring-2 ring-primary/50 border-primary',
          isStuck && 'ring-2 ring-warning/50 border-warning',
          needsReview && 'ring-2 ring-purple-500/50 border-purple-500/50',
          isDone && 'opacity-80'
        )}
        onClick={onClick}
      >
        <CardContent className="p-4 overflow-hidden min-w-0">
          {/* Header with title and status */}
          <div className="flex items-start justify-between gap-3 min-w-0">
            {/* Title with tooltip for truncation */}
            <Tooltip>
              <TooltipTrigger asChild>
                <h3 className="font-medium text-sm text-foreground line-clamp-2 flex-1 leading-snug break-words overflow-hidden min-w-0">
                  {task.title}
                </h3>
              </TooltipTrigger>
              {task.title.length > 50 && (
                <TooltipContent side="top" className="max-w-xs">
                  <p className="text-sm">{task.title}</p>
                </TooltipContent>
              )}
            </Tooltip>

            {/* Status indicators */}
            <div className="flex items-center gap-1.5 shrink-0">
              {/* Stuck indicator */}
              {isStuck && (
                <Badge
                  variant="outline"
                  className="text-[10px] px-1.5 py-0 flex items-center gap-1 bg-warning/10 text-warning border-warning/30 animate-pulse"
                >
                  <AlertTriangle className="h-2.5 w-2.5" />
                  Stuck
                </Badge>
              )}
              {/* Execution phase badge - shown when actively running */}
              {hasActiveExecution && executionPhase && !isStuck && (
                <Badge
                  variant="outline"
                  className={cn(
                    'text-[10px] px-1.5 py-0 flex items-center gap-1 status-running',
                    EXECUTION_PHASE_BADGE_COLORS[executionPhase]
                  )}
                >
                  <Loader2 className="h-2.5 w-2.5 animate-spin" />
                  {EXECUTION_PHASE_LABELS[executionPhase]}
                </Badge>
              )}
              <Badge
                variant={isStuck ? 'warning' : getStatusBadgeVariant(task.status)}
                className={cn(isRunning && !isStuck && 'status-running')}
              >
                {isStuck ? 'Recovery' : getStatusLabel(task.status)}
              </Badge>
            </div>
          </div>

          {/* Description - improved truncation */}
          {task.description && (
            <Tooltip>
              <TooltipTrigger asChild>
                <p className="mt-2 text-xs text-muted-foreground line-clamp-2 leading-relaxed break-words overflow-hidden min-w-0">
                  {task.description}
                </p>
              </TooltipTrigger>
              {task.description.length > 100 && (
                <TooltipContent side="bottom" className="max-w-sm">
                  <p className="text-sm">{task.description}</p>
                </TooltipContent>
              )}
            </Tooltip>
          )}

          {/* Metadata badges with overflow handling */}
          {badges.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              {visibleBadges.map((badge) => (
                <span key={badge.key}>{badge.element}</span>
              ))}
              {hiddenBadges.length > 0 && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="badge-overflow cursor-help">
                      +{hiddenBadges.length}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="flex flex-wrap gap-1.5 max-w-xs p-2">
                    {hiddenBadges.map((badge) => (
                      <span key={badge.key}>{badge.element}</span>
                    ))}
                  </TooltipContent>
                </Tooltip>
              )}
            </div>
          )}

          {/* Progress section - enhanced */}
          {(task.chunks.length > 0 || hasActiveExecution) && (
            <div className="mt-4 min-w-0">
              <div className="flex items-center justify-between mb-1.5 min-w-0 gap-2">
                <span className="text-[11px] text-muted-foreground font-medium truncate min-w-0 flex-1">
                  {hasActiveExecution && task.executionProgress?.message
                    ? task.executionProgress.message
                    : task.chunks.length > 0
                      ? `${task.chunks.filter(c => c.status === 'completed').length}/${task.chunks.length} chunks`
                      : 'Progress'}
                </span>
                <span className={cn(
                  'text-xs font-semibold tabular-nums shrink-0',
                  isDone ? 'text-success' : 'text-foreground'
                )}>
                  {hasActiveExecution
                    ? `${task.executionProgress?.overallProgress || 0}%`
                    : `${progress}%`}
                </span>
              </div>
              <div className={cn('rounded-full', getProgressClassName())}>
                <Progress
                  value={hasActiveExecution ? (task.executionProgress?.overallProgress || 0) : progress}
                  className={cn(
                    'h-1.5',
                    isDone && '[&>div]:bg-success',
                    hasActiveExecution && '[&>div]:bg-info'
                  )}
                />
              </div>

              {/* Chunk indicators - improved with tooltips */}
              {task.chunks.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1 items-center">
                  {task.chunks.slice(0, 10).map((chunk) => (
                    <Tooltip key={chunk.id}>
                      <TooltipTrigger asChild>
                        <div
                          className={cn(
                            'chunk-dot',
                            CHUNK_STATUS_COLORS[chunk.status]
                          )}
                        />
                      </TooltipTrigger>
                      <TooltipContent side="top" className="text-xs">
                        <p className="font-medium">{chunk.id}</p>
                        <p className="text-muted-foreground capitalize">{chunk.status}</p>
                      </TooltipContent>
                    </Tooltip>
                  ))}
                  {task.chunks.length > 10 && (
                    <span className="text-[10px] text-muted-foreground ml-0.5">
                      +{task.chunks.length - 10}
                    </span>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Footer - improved layout */}
          <div className="mt-4 flex items-center justify-between min-w-0 gap-2">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground min-w-0 shrink-0">
              <Clock className="h-3 w-3" />
              <span>{formatRelativeTime(task.updatedAt)}</span>
            </div>

            {/* Action buttons */}
            {isStuck ? (
              <Button
                variant="warning"
                size="sm"
                className="h-7 px-2.5 shadow-sm"
                onClick={handleRecover}
                disabled={isRecovering}
              >
                {isRecovering ? (
                  <>
                    <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
                    Recovering...
                  </>
                ) : (
                  <>
                    <RotateCcw className="mr-1.5 h-3 w-3" />
                    Recover
                  </>
                )}
              </Button>
            ) : (task.status === 'backlog' || task.status === 'in_progress') ? (
              <Button
                variant={isRunning ? 'destructive' : 'default'}
                size="sm"
                className="h-7 px-2.5 shadow-sm"
                onClick={handleStartStop}
              >
                {isRunning ? (
                  <>
                    <Square className="mr-1.5 h-3 w-3" />
                    Stop
                  </>
                ) : (
                  <>
                    <Play className="mr-1.5 h-3 w-3" />
                    Start
                  </>
                )}
              </Button>
            ) : (
              <ChevronRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
            )}
          </div>
        </CardContent>
      </Card>
    </TooltipProvider>
  );
}
