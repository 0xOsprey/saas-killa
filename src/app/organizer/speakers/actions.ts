'use server';

import { and, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { db } from '@/db';
import { roleEnum, userRoles } from '@/db/schema';
import { requireRole } from '@/lib/auth';

const roleSchema = z.object({
  userId: z.string().uuid(),
  role: z.enum(roleEnum.enumValues),
});

/** Grant a role. Reviewer and organizer are given here and never self-assigned. */
export async function grantRoleAction(formData: FormData): Promise<void> {
  await requireRole('organizer');
  const input = roleSchema.parse({
    userId: formData.get('userId'),
    role: formData.get('role'),
  });
  await db.insert(userRoles).values(input).onConflictDoNothing();
  revalidatePath('/organizer/speakers');
}

export async function revokeRoleAction(formData: FormData): Promise<void> {
  const actor = await requireRole('organizer');
  const input = roleSchema.parse({
    userId: formData.get('userId'),
    role: formData.get('role'),
  });

  // Refuse to let an organizer drop their own organizer role. Doing so is
  // always a mistake and it can lock the last organizer out of the admin
  // screens with no way back in short of a database edit.
  if (input.userId === actor.id && input.role === 'organizer') return;

  await db
    .delete(userRoles)
    .where(and(eq(userRoles.userId, input.userId), eq(userRoles.role, input.role)));
  revalidatePath('/organizer/speakers');
}
