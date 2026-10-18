import { useTranslation } from 'react-i18next';
import { ExternalLink } from '@/components/external-link';
import { REPO_URL, ISSUES_URL, SECURITY_URL, UPSTREAM_REPO_URL } from '@shared/utils/contactLinks';

export function SupportSettings() {
  const { t } = useTranslation();
  return (
    <section className="space-y-4 p-4">
      <h1 className="text-xl font-semibold">{t('app.name')}</h1>
      <p className="text-sm text-muted-foreground">{t('app.tagline')}</p>
      <div className="flex flex-wrap gap-4 text-sm">
        <ExternalLink href={REPO_URL}>{t('support.star_github')}</ExternalLink>
        <ExternalLink href={ISSUES_URL}>{t('contact.feature_cta')}</ExternalLink>
        <ExternalLink href={SECURITY_URL}>{t('contact.security_cta')}</ExternalLink>
      </div>
      <ExternalLink href={UPSTREAM_REPO_URL}>
        {t('about.original_project', { name: 'VoiceStudio' })}
      </ExternalLink>
    </section>
  );
}
