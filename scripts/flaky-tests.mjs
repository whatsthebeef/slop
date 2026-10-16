// Lists the tests that failed and then passed on retry, from a vitest JSON report (`--reporter=json`): a passed test that
// still carries failure messages was retried. Prints JSON to stdout: [{ file, test, failures }]. CI uploads it so slop can
// show "flaky: <test>" on the glob's checks without failing them.
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';

export const flakyTests = (report, cwd = process.cwd()) =>
  (report.testResults ?? []).flatMap((file) =>
    (file.assertionResults ?? [])
      .filter((t) => t.status === 'passed' && (t.failureMessages ?? []).length > 0)
      .map((t) => ({
        file: relative(cwd, file.name ?? ''),
        test: t.fullName,
        failures: t.failureMessages.map((m) => String(m).split('\n')[0]),
      })),
  );

if (process.argv[1]?.endsWith('flaky-tests.mjs') && process.argv[2]) {
  console.log(JSON.stringify(flakyTests(JSON.parse(readFileSync(process.argv[2], 'utf8'))), null, 2));
}
