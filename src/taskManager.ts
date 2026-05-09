import { ChatSession } from "./chatSession";
import { AgentProvider } from "./providers";
import { AppSnapshot, TaskSnapshot, TaskSummary } from "./types";

interface TaskRecord {
  id: string;
  session: ChatSession;
}

export class TaskManager {
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly order: string[] = [];
  private activeTaskId: string;
  private createdCount = 0;

  constructor(private readonly providers: AgentProvider[]) {
    this.activeTaskId = this.createTaskRecord().id;
  }

  createTask(title?: string): AppSnapshot {
    const record = this.createTaskRecord(title);
    this.activeTaskId = record.id;
    return this.getSnapshot();
  }

  switchTask(taskId: string): AppSnapshot {
    if (this.tasks.has(taskId)) {
      this.activeTaskId = taskId;
    }
    return this.getSnapshot();
  }

  closeTask(taskId: string): AppSnapshot {
    const record = this.tasks.get(taskId);
    if (!record) {
      return this.getSnapshot();
    }

    if (record.session.getSnapshot().isResponding) {
      return this.getSnapshot();
    }

    this.tasks.delete(taskId);
    const orderIndex = this.order.indexOf(taskId);
    if (orderIndex >= 0) {
      this.order.splice(orderIndex, 1);
    }

    if (this.order.length === 0) {
      this.activeTaskId = this.createTaskRecord().id;
      return this.getSnapshot();
    }

    if (this.activeTaskId === taskId) {
      this.activeTaskId = this.order[Math.max(0, orderIndex - 1)] ?? this.order[0];
    }

    return this.getSnapshot();
  }

  getSnapshot(): AppSnapshot {
    const activeTask = this.getActiveRecord();
    return {
      tasks: this.getTaskSummaries(),
      activeTaskId: activeTask.id,
      activeTask: this.toTaskSnapshot(activeTask)
    };
  }

  getActiveRecord(): TaskRecord {
    const record = this.tasks.get(this.activeTaskId);
    if (record) {
      return record;
    }

    const created = this.createTaskRecord();
    this.activeTaskId = created.id;
    return created;
  }

  getTask(taskId: string): TaskRecord | undefined {
    return this.tasks.get(taskId);
  }

  private createTaskRecord(title?: string): TaskRecord {
    this.createdCount += 1;
    const id = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const session = new ChatSession(this.providers);
    session.seedTitle(title?.trim() || `Task ${this.createdCount}`);

    const record = { id, session };
    this.tasks.set(id, record);
    this.order.push(id);
    return record;
  }

  private getTaskSummaries(): TaskSummary[] {
    return this.order
      .map((taskId) => this.tasks.get(taskId))
      .filter((record): record is TaskRecord => Boolean(record))
      .map((record) => record.session.getSummary(record.id));
  }

  private toTaskSnapshot(record: TaskRecord): TaskSnapshot {
    const summary = record.session.getSummary(record.id);
    return {
      id: record.id,
      title: summary.title,
      updatedAt: summary.updatedAt,
      chat: record.session.getSnapshot()
    };
  }
}
