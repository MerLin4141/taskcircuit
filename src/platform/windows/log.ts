import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
export class RuntimeLog {
  private path: string;
  constructor(
    home: string,
    private maxBytes = 10 * 1024 * 1024,
    private backups = 5,
  ) {
    const dir = join(home, "logs");
    mkdirSync(dir, { recursive: true });
    this.path = join(dir, "runtime.log");
  }
  write(component: string, level: string, message: string): void {
    const line =
      JSON.stringify({
        timestamp: new Date().toISOString(),
        component,
        level,
        message,
      }) + "\n";
    if (
      existsSync(this.path) &&
      statSync(this.path).size + Buffer.byteLength(line) > this.maxBytes
    ) {
      const last = `${this.path}.${this.backups}`;
      if (existsSync(last)) unlinkSync(last);
      for (let i = this.backups - 1; i >= 1; i--) {
        const before = `${this.path}.${i}`;
        if (existsSync(before)) renameSync(before, `${this.path}.${i + 1}`);
      }
      renameSync(this.path, `${this.path}.1`);
    }
    appendFileSync(this.path, line);
  }
}
