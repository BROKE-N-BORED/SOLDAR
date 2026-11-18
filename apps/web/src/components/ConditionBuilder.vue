<!-- Condition builder for the IF node: rows of left / operator / right, so
     nobody has to hand-write the { left, operator, right } JSON. Left and
     right may hold {{ }} expressions, typed as plain text. -->

<template>
  <div class="condition-builder">
    <div
      v-for="(row, index) in rows"
      :key="index"
      class="condition-row"
    >
      <input
        class="field-input"
        type="text"
        placeholder="Value, e.g. {{ $json.age }}"
        aria-label="Left side"
        :value="textOf(row.left)"
        @input="setRow(index, 'left', ($event.target as HTMLInputElement).value)"
      />
      <select
        class="field-input condition-operator"
        aria-label="Operator"
        :value="row.operator"
        @change="setRow(index, 'operator', ($event.target as HTMLSelectElement).value)"
      >
        <option
          v-for="op in OPERATORS"
          :key="op.value"
          :value="op.value"
        >
          {{ op.label }}
        </option>
      </select>
      <input
        v-if="needsRight(row.operator)"
        class="field-input"
        type="text"
        placeholder="Compare with"
        aria-label="Right side"
        :value="textOf(row.right)"
        @input="setRow(index, 'right', ($event.target as HTMLInputElement).value)"
      />
      <button
        class="btn btn-icon"
        type="button"
        title="Remove this condition"
        aria-label="Remove this condition"
        @click="removeRow(index)"
      >
        X
      </button>
    </div>
    <button class="btn btn-secondary btn-small" type="button" @click="addRow">
      Add a condition
    </button>
    <p v-if="rows.length === 0" class="field-help">
      An IF node needs at least one condition, or the run fails.
    </p>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

interface ConditionRow {
  left: unknown;
  operator: string;
  right?: unknown;
}

const props = defineProps<{
  modelValue: unknown;
}>();

const emit = defineEmits<{
  (event: 'update:modelValue', value: ConditionRow[]): void;
}>();

const OPERATORS = [
  { value: 'equals', label: 'is' },
  { value: 'notEquals', label: 'is not' },
  { value: 'contains', label: 'contains' },
  { value: 'notContains', label: 'does not contain' },
  { value: 'greaterThan', label: 'is more than' },
  { value: 'lessThan', label: 'is less than' },
  { value: 'greaterThanOrEqual', label: 'is at least' },
  { value: 'lessThanOrEqual', label: 'is at most' },
  { value: 'isEmpty', label: 'is empty' },
  { value: 'isNotEmpty', label: 'is not empty' },
  { value: 'startsWith', label: 'starts with' },
  { value: 'endsWith', label: 'ends with' },
] as const;

const OPERATOR_VALUES = new Set(OPERATORS.map((op) => op.value));

function needsRight(operator: string): boolean {
  return operator !== 'isEmpty' && operator !== 'isNotEmpty';
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  return String(value);
}

// Only well-formed rows are shown; anything else in the stored value is
// dropped when the user next edits (the builder always writes valid rows).
const rows = computed<ConditionRow[]>(() => {
  if (!Array.isArray(props.modelValue)) return [];
  const out: ConditionRow[] = [];
  for (const entry of props.modelValue) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const operator = typeof record.operator === 'string' ? record.operator : '';
    if (!OPERATOR_VALUES.has(operator as (typeof OPERATORS)[number]['value'])) continue;
    out.push({
      left: record.left ?? '',
      operator,
      right: needsRight(operator) ? (record.right ?? '') : undefined,
    });
  }
  return out;
});

function setRow(index: number, field: 'left' | 'operator' | 'right', value: string): void {
  const next = rows.value.map((row) => ({ ...row }));
  const row = next[index];
  if (!row) return;
  if (field === 'operator') {
    row.operator = value;
    // Empty-checks take no right side; switching back restores a blank one.
    row.right = needsRight(value) ? (row.right ?? '') : undefined;
  } else {
    row[field] = value;
  }
  emit('update:modelValue', next);
}

function addRow(): void {
  emit('update:modelValue', [
    ...rows.value.map((row) => ({ ...row })),
    { left: '', operator: 'equals', right: '' },
  ]);
}

function removeRow(index: number): void {
  const next = rows.value.map((row) => ({ ...row }));
  next.splice(index, 1);
  emit('update:modelValue', next);
}
</script>
