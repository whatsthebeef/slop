import { createContext, useCallback, useContext, useState } from 'react';
import type { ReactNode } from 'react';

type Show = (message: ReactNode, ms?: number) => void;

const ToastContext = createContext<Show>(() => undefined);

export const useToast = () => useContext(ToastContext);

export const ToastProvider = ({ children }: { children: ReactNode }) => {
  const [messages, setMessages] = useState<{ id: number; content: ReactNode }[]>([]);
  const show = useCallback<Show>((content, ms = 5000) => {
    const id = Date.now() + Math.random();
    setMessages((m) => [...m, { id, content }]);
    setTimeout(() => setMessages((m) => m.filter((x) => x.id !== id)), ms);
  }, []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className='fixed right-4 bottom-4 z-50 grid max-w-sm gap-2' role='status' aria-live='polite'>
        {messages.map((m) => (
          <div key={m.id} className='rounded-md border bg-card px-3 py-2 text-sm shadow-lg'>
            {m.content}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
};
