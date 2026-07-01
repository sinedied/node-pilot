import { entity, uuid, text } from '@microsoft/rayfin-core';

@entity()
export class Tag {
  @uuid() id!: string;
  @text({ max: 40 }) name!: string;
  @text({ max: 20, optional: true }) color?: string;
}
