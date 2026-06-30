import { entity, uuid, text, boolean, date, one, many } from '@microsoft/rayfin-core';
import { Project } from './Project.js';
import { User } from './User.js';
import { Tag } from './Tag.js';
import { Comment } from './Comment.js';

@entity()
export class Todo {
  @uuid() id!: string;
  @text({ max: 200 }) title!: string;
  @text({ max: 2000, optional: true }) notes?: string;
  @boolean({ default: false }) done!: boolean;
  @text({ max: 20, optional: true }) priority?: string;
  @date() createdAt!: Date;
  @one(() => Project) project!: Project;
  @one(() => User) assignee!: User;
  @many(() => Tag) tags!: Tag[];
  @many(() => Comment) comments!: Comment[];
}
