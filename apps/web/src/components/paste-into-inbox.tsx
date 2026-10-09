import { useState } from 'react';
import type { SyntheticEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input, Label, Textarea } from '@/components/ui/input';
import { api, RequestError } from '@/lib/api';
import { useToast } from '@/toast';

/** The Paste into inbox dialog: text, and optionally a title, the date it happened and where it came from. */
export const PasteIntoInbox = ({
  boardId,
  open,
  onOpenChange,
  onAdded,
}: {
  boardId: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded: () => void;
}) => {
  const toast = useToast();
  const [text, setText] = useState('');
  const [title, setTitle] = useState('');
  const [date, setDate] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const added = await api.addToInbox(boardId, {
        text,
        ...(title.trim() === '' ? {} : { title: title.trim() }),
        ...(date === '' ? {} : { occurredAt: date }),
        ...(label.trim() === '' ? {} : { sourceLabel: label.trim() }),
      });
      // The same text is one item: say so rather than silently doing nothing.
      toast(added.created ? 'Added to the inbox' : 'That is already in the inbox');
      setText('');
      setTitle('');
      setDate('');
      setLabel('');
      onAdded();
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof RequestError ? e.body.message : 'Could not add it');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Paste into inbox">
        <form className="grid gap-3" onSubmit={(e) => void submit(e)}>
          <Label>
            Text
            <Textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              className="min-h-48"
              placeholder="Meeting notes, a chat thread or a document"
              autoFocus
            />
          </Label>
          <Label>
            Title (optional)
            <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
          </Label>
          <div className="grid grid-cols-2 gap-3">
            <Label>
              Date (optional)
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </Label>
            <Label>
              Source (optional)
              <Input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                maxLength={100}
                placeholder="Tuesday standup"
              />
            </Label>
          </div>
          {error !== null && <p className="text-sm text-red">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || text.trim() === ''}>
              {busy ? 'Adding…' : 'Add to inbox'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
};
