import { redirect } from 'next/navigation';
import { Button, Card, Field, LinkButton, Notice, PageHeader } from '@/components/ui';
import { currentUser } from '@/lib/auth';
import { UPLOAD_KINDS, acceptAttribute, formatBytes, headshotUpload } from '@/lib/uploads';
import { Headshot } from './Headshot';
import { ProfileForm } from './ProfileForm';
import { removeHeadshot, uploadHeadshot } from './actions';

/**
 * The speaker's own profile. Anyone signed in may edit theirs, whatever roles
 * they hold; the action writes the session's own user id and no other.
 *
 * The headshot has two doors and they are separate forms on purpose. Upload is
 * a plain server-action form that redirects, so the page reloads and the
 * preview shows the file that was actually stored. The URL field lives in
 * `ProfileForm`, a client component holding its own preview state, and a file
 * input inside it would leave that state showing a URL the server had replaced.
 *
 * Separate forms, but only one visible door at a time. An upload writes its own
 * `/files/…` path into `headshotUrl`, so leaving the URL field on screen after
 * one showed the speaker a value they never typed under a control that already
 * displayed the image. `hasUpload` picks the door: the URL field is the
 * fallback for someone who has not uploaded anything.
 */
export default async function SpeakerProfilePage({
  searchParams,
}: {
  searchParams: Promise<{ uploaded?: string; removed?: string; error?: string }>;
}) {
  const user = await currentUser();
  if (!user) redirect('/login');

  const [uploaded, params] = await Promise.all([headshotUpload(user.id), searchParams]);

  return (
    <div className="max-w-2xl space-y-6">
      <PageHeader
        title="Your profile"
        description="Shown beside your talk on the public agenda."
        action={
          <LinkButton href="/speaker" variant="secondary">
            My submissions
          </LinkButton>
        }
      />

      {params.error ? (
        <Notice tone="bad">
          <span data-testid="headshot-error">{params.error}</span>
        </Notice>
      ) : null}
      {params.uploaded ? (
        <Notice tone="good">
          <span data-testid="headshot-uploaded">
            Headshot uploaded. It is beside your talks on the public agenda.
          </span>
        </Notice>
      ) : null}
      {params.removed ? <Notice tone="accent">Headshot removed.</Notice> : null}

      <Card className="space-y-4">
        <div className="flex items-center gap-4">
          <Headshot url={user.headshotUrl} name={user.name} email={user.email} size="lg" />
          <div className="min-w-0">
            <h2 className="text-sm font-medium text-ink">Headshot</h2>
            <p className="truncate text-xs text-muted" data-testid="headshot-file-meta">
              {uploaded
                ? `${uploaded.filename} · ${formatBytes(uploaded.bytes)}`
                : 'Upload an image, or paste a link to one below.'}
            </p>
          </div>
        </div>

        <form action={uploadHeadshot} className="space-y-3">
          <Field
            label="Upload an image"
            hint={`PNG, JPEG, GIF or WebP, up to ${formatBytes(
              UPLOAD_KINDS.headshot.maxBytes,
            )}. It replaces whatever is there now.`}
          >
            <input
              type="file"
              name="headshotFile"
              accept={acceptAttribute('headshot')}
              required
              data-testid="headshot-file"
              className="block w-full text-sm text-ink file:mr-3 file:rounded-md file:border file:border-line file:bg-white file:px-3 file:py-1.5 file:text-sm file:font-medium hover:file:bg-slate-50"
            />
          </Field>
          <Button type="submit" variant="secondary" data-testid="headshot-upload">
            Upload headshot
          </Button>
        </form>

        {uploaded ? (
          <form action={removeHeadshot}>
            <input type="hidden" name="uploadId" value={uploaded.id} />
            <Button type="submit" variant="ghost" className="text-xs" data-testid="headshot-remove">
              Remove the uploaded headshot
            </Button>
          </form>
        ) : null}
      </Card>

      <ProfileForm
        email={user.email}
        name={user.name}
        bio={user.bio}
        headshotUrl={user.headshotUrl}
        hasUpload={Boolean(uploaded)}
      />
    </div>
  );
}
