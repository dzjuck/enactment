/**
 * Wrap one step's YAML lines in the plan document the harness loads.
 *
 * The suites exercise a single step each, so the step body stays exactly what it was; only
 * the plan envelope around it is new.
 */
export function planDocument(
  stepLines: string[],
  options: { id?: string; finalCommand?: string[]; documentation?: { url: string; path: string }[] } = {},
): string {
  const final = options.finalCommand ?? ['node', '--version'];
  const documentation =
    options.documentation === undefined
      ? []
      : [
          'documentation:',
          '  sources:',
          ...options.documentation.flatMap((source) => [
            `    - url: ${source.url}`,
            `      path: ${source.path}`,
          ]),
        ];

  return [
    'version: 1',
    `id: ${options.id ?? 'harness-test-plan'}`,
    ...documentation,
    'steps:',
    ...stepLines.map((line, index) => (index === 0 ? `  - ${line}` : `    ${line}`)),
    'final_verification:',
    '  commands:',
    `    - ${JSON.stringify(final)}`,
    '',
  ].join('\n');
}
