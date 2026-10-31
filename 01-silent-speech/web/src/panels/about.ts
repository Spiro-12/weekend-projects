import type { Panel } from '../core/app';

const panel: Panel = {
  id: 'about',
  order: 900,
  title: 'What is this?',
  mount(el) {
    el.innerHTML = `
      <p>Silently mouth a sentence while wearing AirPods. The AirPods' head motion sensor picks up tiny jaw movements,
      and this page figures out which sentence you said, then does it for real on a Mac.</p>
      <p class="muted">No AirPods? The page opens with a replay of a real recorded session. To try it yourself with fake data, use
      the "Try it yourself" button, pick a sentence at the top, and hold <kbd>Space</kbd>.</p>
      <p class="muted"><a href="https://github.com/Spiro-12/weekend-projects/tree/main/01-silent-speech">Code on GitHub</a></p>`;
  },
};
export default panel;
