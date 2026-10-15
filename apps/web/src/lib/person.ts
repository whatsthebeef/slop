/** A person's first name from their email: `john.bower@x.com` is "John". Slop keeps no display names, so the address is all there is. */
export const firstNameOf = (email: string): string => {
  const first = (email.split('@')[0] ?? '').split(/[._+-]/)[0] ?? '';
  return first === '' ? email : first.charAt(0).toUpperCase() + first.slice(1);
};
