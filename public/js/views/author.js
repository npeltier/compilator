// Author view: home grid filtered to a single author. Reuses home.js logic by
// delegating with a synthetic query context.

import { mount as mountHome } from './home.js';

export async function mount(el, { params }) {
  return mountHome(el, { params: {}, query: { author: params.name } });
}
