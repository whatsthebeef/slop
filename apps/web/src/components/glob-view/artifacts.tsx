import { ArtifactsSection } from '../artifacts';
import type { ArtifactRef } from '../artifacts';
import type { GlobViewContext } from './context';

/** The artifacts section; `selected` is the artifact open in it. */
export const ArtifactsPanel = ({
  ctx,
  selected,
  onSelect,
}: {
  ctx: GlobViewContext;
  selected: ArtifactRef | null;
  onSelect: (artifact: ArtifactRef | null) => void;
}) => (
  <ArtifactsSection
    globId={ctx.glob.id}
    boardId={ctx.glob.boardId}
    artifacts={ctx.glob.artifacts ?? []}
    signedOff={ctx.glob.status === 'signed_off'}
    selected={selected}
    onSelect={onSelect}
  />
);
