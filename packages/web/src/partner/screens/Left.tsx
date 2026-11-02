/** v0.12 People: after she leaves or is removed (`/p/left`): a goodbye, and Export while sharing is ending. */
import type { PersonMe } from '@jantar/protocol/people';
import { Page } from '../App.js';
import type { PersonApi } from '../api.js';

export function Left({ me, api }: { me: PersonMe | null; api: PersonApi }) {
  if (me && me.person.state === 'ending') {
    return (
      <Page title="Sharing is ending">
        <p>Download your data before {me.person.endingUntil?.slice(0, 10)}.</p>
        <p className="mt-12">
          <a className="underline" href={api.exportUrl('html')}>Download as a page</a> ·{' '}
          <a className="underline" href={api.exportUrl('json')}>data file (JSON)</a>
        </p>
      </Page>
    );
  }
  return <Page title="You've left">You've left this space. Thank you.</Page>;
}
