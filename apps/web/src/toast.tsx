import { createContext, useCallback, useContext, useState } from 'react';
import type { ReactNode } from 'react';

const ToastContext = createContext<(message: string) => void>(() => undefined);

export const useToast = () => useContext(ToastContext);

export const ToastProvider = ({ children }: { children: ReactNode }) => {
  const [messages, setMessages] = useState<{ id: number; text: string }[]>([]);
  const show = useCallback((text: string) => {
    const id = Date.now() + Math.random();
    setMessages((m) => [...m, { id, text }]);
    setTimeout(() => setMessages((m) => m.filter((x) => x.id !== id)), 5000);
  }, []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className='fixed right-4 bottom-4 z-50 grid max-w-sm gap-2' role='status' aria-live='polite'>
        {messages.map((m) => (
          <div key={m.id} className='rounded-md border bg-card px-3 py-2 text-sm shadow-lg'>
            {m.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
};
