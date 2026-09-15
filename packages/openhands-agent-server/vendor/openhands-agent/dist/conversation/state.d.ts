import { type ActionEvent, type AgentErrorEvent, type Event } from '../event/index.js';
import { type Message } from '../llm/index.js';
import { type ConversationStats } from '../llm/metrics.js';
import { type EventLog } from './event-log.js';
export declare const conversationExecutionStatus: {
    readonly IDLE: "idle";
    readonly RUNNING: "running";
    readonly PAUSED: "paused";
    readonly FINISHED: "finished";
    readonly ERROR: "error";
    readonly STUCK: "stuck";
    readonly DELETING: "deleting";
};
export type ConversationExecutionStatus = (typeof conversationExecutionStatus)[keyof typeof conversationExecutionStatus];
export interface ConversationStateOptions {
    readonly events?: readonly Event[];
    readonly executionStatus?: ConversationExecutionStatus;
    readonly eventLog?: EventLog | null;
}
export declare class ConversationState {
    readonly events: Event[];
    readonly eventLog: EventLog | null;
    executionStatus: ConversationExecutionStatus;
    get stats(): ConversationStats;
    constructor(options?: ConversationStateOptions);
    appendEvent(event: Event): Event;
    appendEventAsync(event: Event): Promise<Event>;
    appendEventsAsync(events: readonly Event[]): Promise<readonly Event[]>;
    syncFromDisk(): void;
    pendingActions(): ActionEvent[];
    emitOrphanedActionErrors(error?: string): AgentErrorEvent[];
    static getUnmatchedActions(events: readonly Event[]): ActionEvent[];
}
export declare function actionEventsFromMessage(message: Message, llmResponseId?: string | null): ActionEvent[];
export interface CancellationToken {
    cancel(): void;
    readonly isCancelled: boolean;
}
export declare function cancellationToken(): CancellationToken;
export declare class PendingActionsQueue {
    private readonly queue;
    constructor(actions?: readonly ActionEvent[]);
    get pending(): readonly ActionEvent[];
    enqueue(...actions: readonly ActionEvent[]): number;
    drain(limit?: number): ActionEvent[];
    cancelPending(token: CancellationToken): AgentErrorEvent[];
}
