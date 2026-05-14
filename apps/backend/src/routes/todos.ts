import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type {
  TodoCategoryListResponse,
  TodoCreateResponse,
  TodoItemResponse,
  TodoListResponse,
  TodoReorderRequest
} from "@agentmesh/shared";

import { TodoService } from "../services/todos.js";
import { validateBody, validateParams } from "../validation.js";

const createTodoSchema = z
  .object({
    name: z.string().trim().min(1),
    description: z.string().optional().default(""),
    dueAt: z.number().int().nullable().optional(),
    deadlineMode: z.enum(["absolute", "relative"]).nullable().optional(),
    relativeDurationMinutes: z.number().int().min(0).nullable().optional(),
    category: z.string().nullable().optional(),
  })
  .strict();

const updateTodoSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    description: z.string().optional(),
    sortIndex: z.number().int().optional(),
    dueAt: z.number().int().nullable().optional(),
    deadlineMode: z.enum(["absolute", "relative"]).nullable().optional(),
    relativeDurationMinutes: z.number().int().min(0).nullable().optional(),
    category: z.string().nullable().optional(),
    done: z.boolean().optional()
  })
  .strict();

const todoParamsSchema = z.object({
  id: z.string().min(1)
});

const reorderSchema = z
  .object({
    ids: z.array(z.string().min(1))
  })
  .strict();

export async function registerTodoRoutes(app: FastifyInstance): Promise<void> {
  const service = new TodoService(app.database, app.events);

  app.get("/api/todos", async (): Promise<TodoListResponse> => {
    return { items: service.list() };
  });

  app.get("/api/todos/categories", async (): Promise<TodoCategoryListResponse> => {
    return { categories: service.listCategories() };
  });

  app.post(
    "/api/todos",
    { preHandler: validateBody(createTodoSchema) },
    async (request): Promise<TodoCreateResponse> => {
      const body = request.body as z.infer<typeof createTodoSchema>;
      return { item: service.create(body) };
    }
  );

  app.patch(
    "/api/todos/:id",
    { preHandler: [validateParams(todoParamsSchema), validateBody(updateTodoSchema)] },
    async (request): Promise<TodoItemResponse> => {
      const { id } = request.params as z.infer<typeof todoParamsSchema>;
      const body = request.body as z.infer<typeof updateTodoSchema>;
      return { item: service.update(id, body) };
    }
  );

  app.delete(
    "/api/todos/:id",
    { preHandler: validateParams(todoParamsSchema) },
    async (request): Promise<{ success: true }> => {
      const { id } = request.params as z.infer<typeof todoParamsSchema>;
      service.delete(id);
      return { success: true };
    }
  );

  app.put(
    "/api/todos/reorder",
    { preHandler: validateBody(reorderSchema) },
    async (request): Promise<TodoListResponse> => {
      const body = request.body as z.infer<typeof reorderSchema>;
      return { items: service.reorder(body.ids) };
    }
  );
}
