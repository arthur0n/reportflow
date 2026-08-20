// app/src/features/extraction/ExtractionFieldTable.tsx
//
// §4.2's repair surface: "every value shown, problems flagged, all editable".
//
// Adapted from smartstocke/src/features/invoice-check/ — `InvoiceReviewStep`'s
// flat label/value rows and `InvoiceItemDecisionList`'s per-row editor — with
// the one structural difference that matters here: smartstocke reviews a FIXED
// invoice shape it wrote by hand, and this reviews whatever the frozen field
// list says (§3.1). So there is no hand-written row anywhere below; the table
// is generated from the tree, and adding a field to a template adds a row here
// with no code change.
//
// AUSTERE ON PURPOSE. No cards, no icons per state, no colour beyond the
// badge: a human is here because something is wrong, and the fastest screen is
// the one where every field is a row and the broken ones carry a word.

import { Fragment, type ReactElement } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { FieldSpec } from "@shared/validation/field-spec";
import {
  PROBLEM_LABEL,
  pathKey,
  type FieldProblem,
} from "@shared/validation/extraction-validation";
import {
  asDraftObject,
  emptyRow,
  withKey,
  type DraftValue,
  type ObjectDraft,
} from "./extraction-draft";

const cellClass =
  "border-b border-[color:var(--rule)] px-2 py-1.5 align-top text-[length:var(--fs-body-sm)]";

const headClass =
  "px-2 pb-1.5 text-left text-[length:var(--fs-eyebrow)] uppercase tracking-[0.12em] text-[color:var(--ink-mute)]";

/** What a value of this type looks like when it is right — shown as the
 * placeholder so the human does not have to guess the format the frozen
 * schema will accept (§3.1's money/date shapes are exact). */
function placeholderFor(type: FieldSpec["type"]): string {
  switch (type) {
    case "money":
      return "1.234,56 €";
    case "date":
      return "dd/mm/aaaa";
    case "integer":
      return "0";
    case "decimal":
      return "0,00";
    case "string":
    case "object":
    case "object[]":
      return "";
  }
}

function ProblemBadge({ problems }: { problems: readonly FieldProblem[] }): ReactElement | null {
  const problem = problems[0];
  if (problem === undefined) {
    return null;
  }
  return (
    <Badge variant={problem.code === "missing" ? "warning" : "destructive"} title={problem.message}>
      {PROBLEM_LABEL[problem.code]}
    </Badge>
  );
}

function problemsFor(
  problems: readonly FieldProblem[],
  path: readonly (string | number)[],
): FieldProblem[] {
  const key = pathKey(path);
  return problems.filter((p) => pathKey(p.path) === key);
}

function FieldLabel({ field, indent }: { field: FieldSpec; indent: boolean }): ReactElement {
  return (
    <div className={indent ? "pl-6" : undefined}>
      <span className="font-[550] text-[color:var(--ink)]">{field.name}</span>
      {field.required && <span className="text-[color:var(--negative)]"> *</span>}
      {field.description.length > 0 && (
        <p className="text-[length:var(--fs-eyebrow)] text-[color:var(--ink-mute)]">
          {field.description}
        </p>
      )}
    </div>
  );
}

/** One leaf: label, editable value, problem. The unit the whole screen is
 * made of. */
function LeafRow({
  field,
  path,
  value,
  problems,
  onChange,
  indent = false,
}: {
  field: FieldSpec;
  path: readonly (string | number)[];
  value: string;
  problems: readonly FieldProblem[];
  onChange: (next: string) => void;
  indent?: boolean;
}): ReactElement {
  return (
    <tr>
      <td className={cellClass}>
        <FieldLabel field={field} indent={indent} />
      </td>
      <td className={cellClass}>
        <Input
          value={value}
          placeholder={placeholderFor(field.type)}
          aria-label={field.name}
          onChange={(e) => {
            onChange(e.target.value);
          }}
        />
      </td>
      <td className={cellClass}>
        <ProblemBadge problems={problemsFor(problems, path)} />
      </td>
    </tr>
  );
}

/** An `object[]` — a sub-table, one column per subfield, rows a human can add
 * and remove. Line items are the one place the field list nests (§3.1), and
 * the one place a document can carry a row count the model got wrong. */
function ArrayRows({
  field,
  path,
  rows,
  problems,
  onChange,
}: {
  field: FieldSpec;
  path: readonly (string | number)[];
  rows: readonly ObjectDraft[];
  problems: readonly FieldProblem[];
  onChange: (next: readonly ObjectDraft[]) => void;
}): ReactElement {
  const children = field.fields ?? [];
  return (
    <tr>
      <td className={cellClass} colSpan={3}>
        <FieldLabel field={field} indent={false} />
        <div className="mt-2 overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                {children.map((child) => (
                  <th key={child.name} className={headClass}>
                    {child.name}
                    {child.required && <span className="text-[color:var(--negative)]"> *</span>}
                  </th>
                ))}
                <th className={headClass} />
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={`${field.name}-${String(index)}`}>
                  {children.map((child) => {
                    const cellPath = [...path, index, child.name];
                    const cellProblems = problemsFor(problems, cellPath);
                    const raw = row[child.name];
                    return (
                      <td key={child.name} className={cellClass}>
                        <Input
                          value={typeof raw === "string" ? raw : ""}
                          placeholder={placeholderFor(child.type)}
                          aria-label={`${field.name}[${String(index)}].${child.name}`}
                          onChange={(e) => {
                            onChange(
                              rows.map((r, i) =>
                                i === index ? withKey(r, child.name, e.target.value) : r,
                              ),
                            );
                          }}
                        />
                        {cellProblems.length > 0 && (
                          <div className="mt-1">
                            <ProblemBadge problems={cellProblems} />
                          </div>
                        )}
                      </td>
                    );
                  })}
                  <td className={cellClass}>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Remover linha ${String(index + 1)} de ${field.name}`}
                      onClick={() => {
                        onChange(rows.filter((_, i) => i !== index));
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-1.5 flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              onChange([...rows, emptyRow(children)]);
            }}
          >
            <Plus className="h-3.5 w-3.5" /> Linha
          </Button>
          <ProblemBadge problems={problemsFor(problems, path)} />
        </div>
      </td>
    </tr>
  );
}

export function ExtractionFieldTable({
  fields,
  draft,
  problems,
  onChange,
}: {
  fields: readonly FieldSpec[];
  draft: ObjectDraft;
  problems: readonly FieldProblem[];
  onChange: (next: ObjectDraft) => void;
}): ReactElement {
  const set = (name: string, value: DraftValue): void => {
    onChange(withKey(draft, name, value));
  };

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] border-collapse">
        <thead>
          <tr>
            <th className={`${headClass} w-[30%]`}>Campo</th>
            <th className={headClass}>Valor extraído</th>
            <th className={`${headClass} w-[18%]`}>Problema</th>
          </tr>
        </thead>
        <tbody>
          {fields.map((field) => {
            const value = draft[field.name];

            if (field.type === "object[]") {
              return (
                <ArrayRows
                  key={field.name}
                  field={field}
                  path={[field.name]}
                  rows={Array.isArray(value) ? value : []}
                  problems={problems}
                  onChange={(next) => {
                    set(field.name, next);
                  }}
                />
              );
            }

            if (field.type === "object") {
              const nested = asDraftObject(value);
              return (
                <Fragment key={field.name}>
                  <tr>
                    <td className={cellClass} colSpan={3}>
                      <FieldLabel field={field} indent={false} />
                    </td>
                  </tr>
                  {(field.fields ?? []).map((child) => {
                    const raw = nested[child.name];
                    return (
                      <LeafRow
                        key={`${field.name}.${child.name}`}
                        field={child}
                        path={[field.name, child.name]}
                        value={typeof raw === "string" ? raw : ""}
                        problems={problems}
                        indent
                        onChange={(next) => {
                          set(field.name, withKey(nested, child.name, next));
                        }}
                      />
                    );
                  })}
                </Fragment>
              );
            }

            return (
              <LeafRow
                key={field.name}
                field={field}
                path={[field.name]}
                value={typeof value === "string" ? value : ""}
                problems={problems}
                onChange={(next) => {
                  set(field.name, next);
                }}
              />
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
