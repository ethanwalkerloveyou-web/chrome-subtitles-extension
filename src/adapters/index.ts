/** 站点适配器注册表。加一个新网站 = 在这里加一行。 */

import type { SiteAdapter } from './types.ts';
import { xAdapter } from './x.ts';
import { youtubeAdapter } from './youtube.ts';

export const siteAdapters: SiteAdapter[] = [youtubeAdapter, xAdapter];
