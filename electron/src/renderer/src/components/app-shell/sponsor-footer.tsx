import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { BlocksIcon, ChevronDownIcon, ChevronUpIcon } from 'lucide-react';
import { runRendererTask } from '@/lib/global-error-recovery';
import { GithubStar } from './github-star';
import './sponsor-footer.css';

export function SponsorFooter() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState(false);
  if (collapsed)
    return (
      <div className="flex h-6 shrink-0 justify-end border-t bg-sidebar px-2">
        <button
          type="button"
          aria-label={t('homeUi.expandFooter')}
          aria-expanded={false}
          onClick={() => setCollapsed(false)}
        >
          <ChevronUpIcon className="size-4" aria-hidden="true" />
        </button>
      </div>
    );
  return (
    <div className="sponsor-footer-host">
      <footer aria-label={t('integrationCatalog.title')} className="sponsor-strip">
        <button
          type="button"
          className="sponsor-footer-action"
          onClick={() =>
            runRendererTask('Open integrations', () => navigate({ to: '/integrations' }))
          }
        >
          <BlocksIcon className="size-4" aria-hidden="true" />
          <span>{t('integrationCatalog.title')}</span>
        </button>
        <div className="sponsor-footer-links">
          <GithubStar />
          <button
            type="button"
            className="sponsor-footer-pro"
            aria-label={t('homeUi.collapseFooter')}
            aria-expanded={true}
            onClick={() => setCollapsed(true)}
          >
            <ChevronDownIcon className="size-4" aria-hidden="true" />
          </button>
        </div>
      </footer>
    </div>
  );
}
