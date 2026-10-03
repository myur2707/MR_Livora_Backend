export type ReportRow = Record<string, string | number | null>;
export interface ReportColumn {
  key: string;
  label: string;
  type: 'text' | 'money' | 'date';
}
export function csvCell(value: string | number | null | undefined): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r\n]/.test(text) || /^[\s\p{Cc}\uFEFF]*[=+\-@]/u.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}
export function reportCsv(columns: ReportColumn[], rows: ReportRow[]): string {
  return (
    '\uFEFF' +
    [
      columns.map((column) => csvCell(column.label)).join(','),
      ...rows.map((row) => columns.map((column) => csvCell(row[column.key])).join(',')),
    ].join('\r\n') +
    '\r\n'
  );
}
