import { entity, uuid, text, many } from '@microsoft/rayfin-core';
import { Project } from './Project.js';

@entity()
export class Category {
  @uuid() id!: string;
  @text({ max: 60 }) name!: string;
  @many(() => Project) projects!: Project[];
}
