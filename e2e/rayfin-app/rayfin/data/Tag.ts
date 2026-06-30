import { entity, uuid, text, many } from '@microsoft/rayfin-core';
import { Todo } from './Todo.js';

@entity()
export class Tag {
  @uuid() id!: string;
  @text({ max: 40 }) label!: string;
  @text({ max: 20, optional: true }) color?: string;
  @many(() => Todo) todos!: Todo[];
}
