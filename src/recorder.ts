// Records a canvas to a video file and downloads it.

// Best first: MP4 (H.264) plays everywhere and uploads to social apps as is;
// WebM is the fallback where a browser cannot record MP4.
const FORMATS: { type: string; extension: string; label: string }[] = [
  { type: 'video/mp4;codecs=avc1.640033', extension: 'mp4', label: 'MP4 (H.264)' },
  { type: 'video/mp4;codecs=avc1.64002A', extension: 'mp4', label: 'MP4 (H.264)' },
  { type: 'video/mp4;codecs=avc1', extension: 'mp4', label: 'MP4 (H.264)' },
  { type: 'video/mp4', extension: 'mp4', label: 'MP4' },
  { type: 'video/webm;codecs=vp9', extension: 'webm', label: 'WebM (VP9)' },
  { type: 'video/webm;codecs=vp8', extension: 'webm', label: 'WebM (VP8)' },
  { type: 'video/webm', extension: 'webm', label: 'WebM' },
];

export interface RecorderEvents {
  started: () => void;
  /** Called once the file has been handed to the browser to save. */
  saved: (fileName: string, label: string) => void;
  failed: (reason: string) => void;
}

export class Recorder {
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private chunks: Blob[] = [];
  private startedAt = 0;
  private tag = '';

  constructor(private readonly events: RecorderEvents) {}

  get active(): boolean {
    return this.recorder !== null;
  }

  /** Seconds recorded so far. */
  get seconds(): number {
    return this.active ? (performance.now() - this.startedAt) / 1000 : 0;
  }

  /**
   * Starts recording `canvas`, or stops the recording in progress.
   * `tag` goes into the file name, e.g. "reel".
   */
  toggle(canvas: HTMLCanvasElement, tag = ''): void {
    if (this.active) this.stop();
    else this.start(canvas, tag);
  }

  private start(canvas: HTMLCanvasElement, tag: string): void {
    if (typeof MediaRecorder === 'undefined' || !canvas.captureStream) {
      this.events.failed('This browser cannot record the canvas.');
      return;
    }
    this.tag = tag;
    const stream = canvas.captureStream(60);
    for (const format of FORMATS) {
      if (!MediaRecorder.isTypeSupported(format.type)) continue;
      try {
        const recorder = new MediaRecorder(stream, { mimeType: format.type, videoBitsPerSecond: 18_000_000 });
        this.chunks = [];
        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) this.chunks.push(e.data);
        };
        recorder.onstop = () => this.save(format.extension, format.label, recorder.mimeType || format.type);
        recorder.onerror = () => this.events.failed('Recording stopped unexpectedly.');
        recorder.start(1000);
        this.recorder = recorder;
        this.stream = stream;
        this.startedAt = performance.now();
        this.events.started();
        return;
      } catch {
        // Try the next format.
      }
    }
    stream.getTracks().forEach((track) => track.stop());
    this.events.failed('No recording format is available in this browser.');
  }

  private stop(): void {
    this.recorder?.stop();
  }

  private save(extension: string, label: string, type: string): void {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.recorder = null;
    this.stream = null;
    const blob = new Blob(this.chunks, { type: type.split(';')[0] });
    this.chunks = [];
    if (blob.size === 0) {
      this.events.failed('Nothing was recorded.');
      return;
    }
    const d = new Date();
    const two = (n: number) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
    const fileName = `ink-${this.tag ? `${this.tag}-` : ''}${stamp}.${extension}`;
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    this.events.saved(fileName, label);
  }
}
