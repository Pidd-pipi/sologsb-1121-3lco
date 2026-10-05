import { JSDOM } from 'jsdom';
import 'fake-indexeddb/auto';
import React from 'react';
import { createRoot } from 'react-dom/client';
import AppRouter from '../src/router';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
(globalThis as any).navigator = dom.window.navigator;
(globalThis as any).HTMLElement = dom.window.HTMLElement;
(globalThis as any).SVGElement = dom.window.SVGElement;
(globalThis as any).ShadowRoot = dom.window.ShadowRoot ?? class {};
(globalThis as any).MutationObserver = dom.window.MutationObserver ?? class {
  observe() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
};
(globalThis as any).Element = dom.window.Element;
(globalThis as any).Node = dom.window.Node;
(globalThis as any).MouseEvent = dom.window.MouseEvent;
(globalThis as any).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
(globalThis as any).DOMRect = dom.window.DOMRect ?? class {};
(globalThis as any).IntersectionObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
(globalThis as any).getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
dom.window.matchMedia = (() => ({
  matches: false,
  addListener() {},
  removeListener() {},
  addEventListener() {},
  removeEventListener() {},
})) as unknown as typeof window.matchMedia;
(globalThis as any).matchMedia = dom.window.matchMedia;
(globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) =>
  setTimeout(() => cb(Date.now()), 0) as unknown as number;
(globalThis as any).cancelAnimationFrame = (id: number) => clearTimeout(id);

const errors: string[] = [];
dom.window.addEventListener('error', (e) => errors.push('window.error: ' + e.message));

async function main() {
  const root = createRoot(document.getElementById('root')!);
  root.render(React.createElement(AppRouter));
  await new Promise((r) => setTimeout(r, 2500));

  const text = document.body.textContent ?? '';
  const ok =
    text.includes('森林样地调查记录台') &&
    text.includes('样地台账') &&
    text.includes('离线合并') &&
    (text.includes('FP-4102') || text.includes('样地总数'));

  if (errors.length) console.error(errors.join('\n'));
  if (!ok) {
    console.error('渲染内容不符合预期：', text.slice(0, 400));
    process.exit(1);
  }
  console.log('✅ 应用引导渲染成功，导航含「离线合并」');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
