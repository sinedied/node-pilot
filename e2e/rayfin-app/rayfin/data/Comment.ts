import { entity, uuid, text, date, one } from '@microsoft/rayfin-core';
import { Todo } from './Todo.js';
import { User } from './User.js';

@entity()
export class Comment {
  @uuid() id!: string;
  @text({ max: 1000 }) body!: string;
  @date() createdAt!: Date;
  @one(() => Todo) todo!: Todo;
  @one(() => User) author!: User;
}
