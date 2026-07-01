import { entity, uuid, text, date, many } from '@microsoft/rayfin-core';
import { Tag } from './Tag.js';

@entity()
export class Note {
  @uuid() id!: string;
  @text({ max: 200 }) title!: string;
  @text({ max: 4000, optional: true }) body?: string;
  @date() createdAt!: Date;
  @many(() => Tag) tags!: Tag[];
}
