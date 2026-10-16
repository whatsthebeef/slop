export interface FlakyTest {
  file: string;
  test: string;
  failures: string[];
}
export function flakyTests(
  report: { testResults?: { name?: string; assertionResults?: { fullName: string; status: string; failureMessages?: string[] }[] }[] },
  cwd?: string,
): FlakyTest[];
