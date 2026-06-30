// Rayfin entity. Defined here and registered in schema.ts. `@role` grants access;
// field decorators describe the columns Rayfin provisions. `import` (not
// `import type`) is required for classes referenced in @one/@many arrows — the
// decorators need the runtime class value.
import { role, uuid, email, text, many } from '@microsoft/rayfin-core';
import { Project } from './Project.js';
import { Todo } from './Todo.js';
import { Comment } from './Comment.js';

@role('admin')
@role('member')
export class User {
  @uuid() id!: string;
  @email() email!: string;
  @text({ max: 120 }) displayName!: string;
  @many(() => Project) projects!: Project[];
  @many(() => Todo) assignedTodos!: Todo[];
  @many(() => Comment) comments!: Comment[];
}
