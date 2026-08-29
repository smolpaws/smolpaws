import { type Event } from '../event/index.js';
import { type FileStore } from '../io/index.js';
import type { Agent } from '../agent/index.js';
import { ConversationState } from './state.js';
import { StuckDetector, type StuckDetectionThresholds } from './stuck-detector.js';
export interface LocalConversationOptions {
    readonly agent: Agent;
    readonly state?: ConversationState;
    readonly maxIterations?: number;
    readonly stuckDetection?: boolean | StuckDetectionThresholds;
    readonly conversationId?: string;
    readonly conversationsDir?: string;
    readonly fileStore?: FileStore;
}
export declare class LocalConversation {
    readonly agent: Agent;
    readonly state: ConversationState;
    readonly maxIterations: number;
    readonly stuckDetector: StuckDetector | null;
    readonly conversationId: string | null;
    constructor(options: LocalConversationOptions);
    sendMessage(text: string): Event;
    sendMessageAsync(text: string): Promise<Event>;
    pause(): void;
    resume(): void;
    run(): Promise<void>;
    /**
     * Nudge once on a repeating action-error streak, otherwise apply isStuck().
     * Returns true when STUCK was set and the run loop should stop.
     */
    private checkStuckOrNudge;
    arun(): Promise<void>;
    private createUserMessageEvent;
    private resetIdleStatusAfterMessage;
}
