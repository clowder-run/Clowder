<script lang="ts">
    import ConnectionField from "$lib/components/clusters/connection-field.svelte";
    import {
        Alert,
        AlertDescription,
    } from "$lib/components/ui/alert";
    import { Button } from "$lib/components/ui/button";
    import { Skeleton } from "$lib/components/ui/skeleton";
    import { orpc, queryClient } from "$lib/api/orpc";
    import { formatDurationMs } from "$lib/format";
    import {
        createMutation,
        createQuery,
    } from "@tanstack/svelte-query";
    import { parseAsBoolean, useQueryState } from "nuqs-svelte";
    import type { CanvasResource } from "../../graph";
    import SettingsTitle from "./settings-title.svelte";

    let { resource }: { resource: CanvasResource } = $props();

    const input = $derived({
        projectId: resource.projectId,
        resourceId: resource.id,
    });

    // Polled while a job runs, so the SSH command shows up once it starts.
    const sandboxQuery = createQuery(() =>
        orpc.sandboxes.get.queryOptions({
            input,
            refetchInterval: (query) =>
                query.state.data?.status === "provisioning" ||
                query.state.data?.status === "destroying"
                    ? 3000
                    : false,
        }),
    );

    const sandbox = $derived(sandboxQuery.data);

    const showPassword = useQueryState(
        "password",
        parseAsBoolean
            .withDefault(false)
            .withOptions({ shallow: true, scroll: false }),
    );

    const passwordQuery = createQuery(() =>
        orpc.sandboxes.password.queryOptions({
            input,
            enabled: showPassword.current,
        }),
    );

    const retryState = createMutation(() =>
        orpc.sandboxes.retry.mutationOptions({
            onSuccess: async () => {
                await queryClient.invalidateQueries({
                    queryKey: orpc.resources.listResources.key(),
                });
                await queryClient.invalidateQueries({
                    queryKey: orpc.sandboxes.key(),
                });
            },
        }),
    );

    const details = $derived(
        sandbox
            ? [
                  ["Image", sandbox.image],
                  ["Cluster", sandbox.clusterName ?? "—"],
                  ["Machine", sandbox.machine ?? "Any"],
                  [
                      "Time to live",
                      sandbox.ttlSeconds
                          ? formatDurationMs(
                                sandbox.ttlSeconds * 1000,
                            )
                          : "No limit",
                  ],
              ]
            : [],
    );
</script>

{#if sandboxQuery.isError}
    <Alert variant="error">
        <AlertDescription>
            {sandboxQuery.error.message}
        </AlertDescription>
    </Alert>
{:else if !sandbox}
    <Skeleton loading label="Loading connection">
        <div class="h-16 rounded-md border"></div>
    </Skeleton>
{:else}
    {#if sandbox.status === "failed"}
        <div>
            <SettingsTitle
                text="Failed"
                description="Its last attempt failed; the Deployments tab shows why."
            />
            <Button
                variant="outline"
                class="mt-4"
                loading={retryState.isPending}
                onclick={() => retryState.mutate(input)}
            >
                Retry
            </Button>
            {#if retryState.isError}
                <p class="mt-2 text-sm text-destructive-foreground">
                    {retryState.error.message}
                </p>
            {/if}
        </div>
    {/if}
    <div>
        <SettingsTitle
            text="SSH"
            description="Log in with the key or password you chose."
        />
        <div class="mt-4">
            {#if sandbox.status === "running" && sandbox.sshHost}
                <ConnectionField
                    label="Command"
                    value={`ssh -p ${sandbox.sshPort} dev@${sandbox.sshHost}`}
                />
            {:else}
                <p
                    class="rounded-md border border-dashed px-4 py-3 text-sm text-muted-foreground"
                >
                    The command shows up once the sandbox is running.
                </p>
            {/if}
        </div>
    </div>
    {#if sandbox.hasPassword}
        <div>
            <SettingsTitle text="Password" />
            <div class="mt-4">
                {#if passwordQuery.data?.password}
                    <ConnectionField
                        label="Password"
                        value={passwordQuery.data.password}
                        secret
                    />
                {:else}
                    <Button
                        variant="outline"
                        loading={passwordQuery.isFetching}
                        onclick={() => (showPassword.current = true)}
                    >
                        Show password
                    </Button>
                {/if}
            </div>
        </div>
    {/if}
    <dl class="divide-y rounded-md border text-sm">
        {#each details as [term, value] (term)}
            <div
                class="flex items-center justify-between gap-4 px-4 py-3"
            >
                <dt class="shrink-0 text-muted-foreground">{term}</dt>
                <dd class="min-w-0 truncate font-mono" title={value}>
                    {value}
                </dd>
            </div>
        {/each}
    </dl>
{/if}
