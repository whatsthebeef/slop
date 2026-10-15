/**
 * Capabilities: things slop can verify about its own deployment, so a human step can say "done when this is on"
 * (`check: fileAttachments`) and slop ticks it itself. The server reports each one it has a switch for on
 * `/api/health`; a capability it has no switch for is left out, never reported as off.
 */
export const CAPABILITY_NAMES = ['fileAttachments', 'attachmentEvents', 'slack', 'codeIndex', 'deployResults', 'atfClientCredentials'] as const;
export type CapabilityName = (typeof CAPABILITY_NAMES)[number];

/** Which capabilities are on; a name missing from the record is one this server can't tell. */
export type Capabilities = Partial<Record<CapabilityName, boolean>>;

export const isCapabilityName = (value: string): value is CapabilityName => CAPABILITY_NAMES.some((name) => name === value);

/** What each capability means, for the System list. */
export const CAPABILITY_TEXT: Readonly<Record<CapabilityName, string>> = {
  fileAttachments: 'File attachments: the bucket is configured and reachable',
  attachmentEvents: 'Upload events: the queue that tells slop a file arrived is configured',
  slack: 'Slack: the signing secret and bot token are set',
  codeIndex: 'Code index: the job that clones and indexes each board\'s repo runs',
  deployResults: 'Deploy results: the key that lets CodeBuild report back is set',
  atfClientCredentials: 'ATF client credentials: slop can create Cognito app clients for runners (permission and scopes in place)',
};
