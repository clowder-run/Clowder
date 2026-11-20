import type { DocsLayoutProps } from 'fumadocs-ui/layouts/docs';
import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { AccentSwitcher } from '@/components/accent-switcher';
import { ClowderLogo } from '@/components/clowder-logo';
import { appName, gitConfig } from './shared';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <>
          <ClowderLogo className="size-6 text-fd-primary" />
          {appName}
        </>
      ),
    },
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
  };
}

export const sidebarOptions: DocsLayoutProps['sidebar'] = {
  footer: <AccentSwitcher />,
};
