import { entity, uuid, text, date, one, many } from '@microsoft/rayfin-core';
import { User } from './User.js';
import { Category } from './Category.js';
import { Todo } from './Todo.js';

@entity()
export class Project {
  @uuid() id!: string;
  @text({ max: 120 }) name!: string;
  @text({ max: 500, optional: true }) description?: string;
  @date() createdAt!: Date;
  @one(() => User) owner!: User;
  @one(() => Category) category!: Category;
  @many(() => Todo) todos!: Todo[];
}
