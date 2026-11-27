import { expect, test } from '@playwright/test';
import { gotoUnlocked } from './pin';

// B3: 칠판 사진의 받침(마커·지우개)이 판서 면(SVG 1280×720)을 차지하지 않는다.
// 판서 면 자리를 사진 좌표로 옮겨 픽셀을 본다. 네 모서리 마개(판서 좌표 약 50×44, 넉넉히 56×46)는 틀이라 뺀다 — 배치 칸은 x 48·y 24 안쪽에서 시작한다.
test('칠판 사진: 판서 면 안에 마커 같은 물건이 없다(모서리 마개 제외)', async ({ page }) => {
  await gotoUnlocked(page);
  await page.getByRole('button', { name: '🧒 아이' }).click();
  const r = await page.evaluate(async () => {
    const frame = document.querySelector('.board .frame')!.getBoundingClientRect();
    const surf = document.querySelector('.board .surface')!.getBoundingClientRect();
    const url = getComputedStyle(document.querySelector('.board .photo')!).backgroundImage.replace(/^url\("?|"?\)$/g, '');
    const img = new Image();
    img.src = url;
    await img.decode();
    const W = img.naturalWidth, H = img.naturalHeight;
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const g = c.getContext('2d')!;
    g.drawImage(img, 0, 0);
    const data = g.getImageData(0, 0, W, H).data;
    const fx = (surf.x - frame.x) / frame.width, fy = (surf.y - frame.y) / frame.height;
    const fw = surf.width / frame.width, fh = surf.height / frame.height;
    const bad: Array<[number, number]> = [];
    for (let by = 0; by < 720; by += 2) {
      for (let bx = 0; bx < 1280; bx += 2) {
        const corner = (bx < 56 || bx >= 1224) && (by < 46 || by >= 674);
        if (corner) continue;
        const x = Math.floor((fx + (bx / 1280) * fw) * W), y = Math.floor((fy + (by / 720) * fh) * H);
        const i = (y * W + x) * 4;
        const [rr, gg, bb] = [data[i], data[i + 1], data[i + 2]];
        const lum = (rr + gg + bb) / 3, chroma = Math.max(rr, gg, bb) - Math.min(rr, gg, bb);
        if (lum < 150 || chroma > 45) bad.push([bx, by]);
      }
    }
    return { count: bad.length, sample: bad.slice(0, 5), aspect: surf.width / surf.height };
  });
  expect(r.aspect).toBeCloseTo(16 / 9, 2); // 판서 면은 SVG viewBox와 같은 16:9
  expect(r.count, JSON.stringify(r.sample)).toBe(0);
});
