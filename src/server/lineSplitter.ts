/** 스트리밍 텍스트 조각을 완성된 줄로 모은다. 빈 줄·공백뿐인 줄은 버린다. */
export class LineSplitter {
  private buf = '';

  push(chunk: string): string[] {
    this.buf += chunk;
    // 줄바꿈이 없으면 나눌 것도 없다: 긴 줄을 잘게 받을 때 조각마다 버퍼 전체를 다시 나누지(O(n²)) 않게.
    if (!chunk.includes('\n')) return [];
    const parts = this.buf.split('\n');
    this.buf = parts.pop() ?? '';
    return parts.map(stripCR).filter(nonBlank);
  }

  flush(): string[] {
    const rest = stripCR(this.buf);
    this.buf = '';
    return nonBlank(rest) ? [rest] : [];
  }
}

const stripCR = (s: string) => (s.endsWith('\r') ? s.slice(0, -1) : s);
const nonBlank = (s: string) => s.trim().length > 0;
