/**
 * 0.13.0 Work's parts as segments under the page's title (Todos'
 * `Segmented fill` pattern, design 6.1): Projects · Clients. Deals and
 * Insights join with their screens. Its own file, so Projects (Work's
 * first chunk) carries nothing of the client screens.
 */
import { routePath } from '../../../lib/router.js';
import { useNavigate } from '../../context.js';
import { Segmented } from '../accounts/Segmented.js';

type Part = 'projects' | 'clients';

/** Projects · Clients under Work's title. */
export function WorkTabs({ tab }: { tab: Part }) {
  const navigate = useNavigate();
  return (
    <div className="px-16 pb-8">
      <Segmented<Part>
        label="Work"
        fill
        value={tab}
        onChange={(t) => navigate(routePath({ name: 'work', ...(t === 'clients' ? { tab: t } : {}) }), { replace: true })}
        segments={[
          { key: 'projects', label: 'Projects' },
          { key: 'clients', label: 'Clients' },
        ]}
      />
    </div>
  );
}
