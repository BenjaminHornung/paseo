import { z } from "zod";

export const workKindSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
export const workCategorySchema = z.strictObject({
  id: workKindSchema.refine(
    (id) => !["ui", "general"].includes(id),
    "ui/general are reserved legacy work kinds",
  ),
  label: z
    .string()
    .min(1)
    .max(120)
    .refine((value) => !!value.trim(), "Category name is required"),
  description: z
    .string()
    .min(1)
    .max(1000)
    .refine((value) => !!value.trim(), "Category description is required"),
  routeIds: z
    .array(workKindSchema)
    .min(1)
    .refine((ids) => new Set(ids).size === ids.length, "Duplicate category routes"),
});
export type WorkCategory = z.infer<typeof workCategorySchema>;
export const workCategoryCatalogSchema = z.array(
  workCategorySchema
    .pick({ id: true, label: true, description: true })
    .extend({ id: workKindSchema }),
);
export const legacyWorkCategories = [
  {
    id: "ui",
    label: "UI",
    description: "User interface implementation, visible layout, interactions and accessibility.",
  },
  {
    id: "general",
    label: "Allgemein",
    description: "Other implementation, infrastructure or analysis work.",
  },
];
export function createWorkCategory(
  label: string,
  description: string,
  routeId: string,
  existing: readonly WorkCategory[],
): WorkCategory {
  const stem =
    label
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "work";
  let id = stem,
    suffix = 1;
  while (["ui", "general"].includes(id) || existing.some((category) => category.id === id))
    id = `${stem}-${suffix++}`;
  return workCategorySchema.parse({
    id,
    label: label.trim(),
    description: description.trim(),
    routeIds: [routeId],
  });
}
