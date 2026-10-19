/** Detector confidence is a fraction in [0, 1], matching the upstream boundary. */
export interface FileEncodingGuess {
    readonly encoding: string | null;
    readonly confidence: number | null;
}
export type FileEncodingDetector = (sample: Uint8Array) => FileEncodingGuess | null | Promise<FileEncodingGuess | null>;
export type FileTextEncoding = 'utf-8' | 'cp1252' | 'latin-1' | 'cp1251';
export interface EncodedTextFile {
    readonly text: string;
    readonly bytes: Buffer;
    readonly encoding: FileTextEncoding;
}
/** Native detector adapter; its heuristics are not charset_normalizer's. */
export declare const detectFileEncoding: FileEncodingDetector;
/** Strict whole-file recovery and bounded detection cache for the file editor. */
export declare class FileEncodingManager {
    private readonly detector;
    private readonly cache;
    constructor(detector?: FileEncodingDetector);
    read(path: string): Promise<EncodedTextFile>;
    create(path: string, text: string): Promise<void>;
    write(path: string, text: string, previous: EncodedTextFile): Promise<void>;
    restore(path: string, previous: EncodedTextFile): Promise<void>;
    private remember;
}
