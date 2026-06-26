// Rayfin data model. Decorators describe entities, fields, relationships and the
// roles allowed to read/write them; Rayfin provisions the database, data APIs
// (Data API Builder) and auth from this file.
import { entity, role, text, uuid, boolean, date, email, one, many } from "@microsoft/rayfin";

@role("admin")
@role("member")
export class User {
  @uuid()
  id!: string;

  @email()
  email!: string;

  @text()
  displayName!: string;

  @many(() => Project, "owner")
  projects!: Project[];

  @many(() => Todo, "assignee")
  assignedTodos!: Todo[];

  @many(() => Comment, "author")
  comments!: Comment[];
}

@entity()
export class Category {
  @uuid()
  id!: string;

  @text({ maxLength: 60 })
  name!: string;

  @many(() => Project, "category")
  projects!: Project[];
}

@entity()
export class Project {
  @uuid()
  id!: string;

  @text({ maxLength: 120 })
  name!: string;

  @text({ nullable: true })
  description?: string;

  @date()
  createdAt!: Date;

  @one(() => User, "projects")
  owner!: User;

  @one(() => Category, "projects")
  category!: Category;

  @many(() => Todo, "project")
  todos!: Todo[];
}

@entity()
export class Todo {
  @uuid()
  id!: string;

  @text({ maxLength: 200 })
  title!: string;

  @text({ nullable: true })
  notes?: string;

  @boolean({ default: false })
  done!: boolean;

  @text({ nullable: true })
  priority?: string;

  @date()
  createdAt!: Date;

  @one(() => Project, "todos")
  project!: Project;

  @one(() => User, "assignedTodos")
  assignee!: User;

  @many(() => Tag, "todos")
  tags!: Tag[];

  @many(() => Comment, "todo")
  comments!: Comment[];
}

@entity()
export class Tag {
  @uuid()
  id!: string;

  @text({ maxLength: 40 })
  label!: string;

  @text({ nullable: true })
  color?: string;

  @many(() => Todo, "tags")
  todos!: Todo[];
}

@entity()
export class Comment {
  @uuid()
  id!: string;

  @text({ maxLength: 1000 })
  body!: string;

  @date()
  createdAt!: Date;

  @one(() => Todo, "comments")
  todo!: Todo;

  @one(() => User, "comments")
  author!: User;
}
