<script lang="ts">
    import { goto } from "$app/navigation";
    import TemplateCatalog from "$lib/components/projects/template-catalog.svelte";
    import { Button } from "$lib/components/ui/button";
    import {
        Dialog,
        DialogContent,
        DialogFooter,
        DialogHeader,
        DialogPanel,
        DialogTitle,
    } from "$lib/components/ui/dialog";
    import { Field, FieldError } from "$lib/components/ui/field";
    import { Label } from "$lib/components/ui/label";
    import {
        Select,
        SelectContent,
        SelectItem,
        SelectTrigger,
        SelectValue,
    } from "$lib/components/ui/select";
    import { orpc } from "$lib/api/orpc";
    import { createQuery } from "@tanstack/svelte-query";
    import { parseAsString, useQueryState } from "nuqs-svelte";

    // The template being deployed, by app id.
    const deploy = useQueryState(
        "deploy",
        parseAsString.withOptions({ shallow: true, scroll: false }),
    );

    const templatesQuery = createQuery(() =>
        orpc.resources.listTemplates.queryOptions(),
    );

    const projectsQuery = createQuery(() =>
        orpc.projects.listProjects.queryOptions({
            enabled: deploy.current !== null,
        }),
    );

    const template = $derived(
        templatesQuery.data?.find((t) => t.appId === deploy.current),
    );

    const projects = $derived(projectsQuery.data ?? []);

    let chosen = $state<string | null>(null);

    // The first project is picked until another one is.
    const projectId = $derived(chosen ?? projects[0]?.id ?? "");

    function continueTo(event: SubmitEvent) {
        event.preventDefault();

        if (projectId && deploy.current)
            void goto(
                `/projects/${projectId}/create/${encodeURIComponent(deploy.current)}`,
            );
    }
</script>

<svelte:head><title>Templates / Clowder</title></svelte:head>

<div class="flex w-full flex-col gap-6 pt-6">
    <h1 class="sr-only">Templates</h1>
    <TemplateCatalog
        href={(appId) =>
            `/templates?deploy=${encodeURIComponent(appId)}`}
        onchoose={(picked) => {
            chosen = null;
            void deploy.set(picked.appId);
        }}
    />
</div>

<Dialog
    bind:open={
        () => deploy.current !== null,
        (open) => {
            if (!open) void deploy.set(null);
        }
    }
>
    <DialogContent class="sm:max-w-md">
        <DialogHeader>
            <DialogTitle>
                Deploy {template?.name ?? "template"}
            </DialogTitle>
        </DialogHeader>
        <DialogPanel>
            <form id="deploy-template-form" onsubmit={continueTo}>
                <Field>
                    <Label for="deploy-template-project" required>
                        Project
                    </Label>
                    {#if projectsQuery.isError}
                        <FieldError>
                            Unable to load projects: {projectsQuery
                                .error.message}
                        </FieldError>
                    {:else if projectsQuery.isSuccess && projects.length === 0}
                        <FieldError>
                            There are no projects yet.
                            <a href="/projects?dialog=create-project">
                                Create one
                            </a>
                            first.
                        </FieldError>
                    {:else}
                        <Select
                            value={projectId || null}
                            items={projects.map((project) => ({
                                value: project.id,
                                label: project.name,
                            }))}
                            disabled={projectsQuery.isPending}
                            onValueChange={(value) =>
                                (chosen = value)}
                        >
                            <SelectTrigger
                                id="deploy-template-project"
                            >
                                <SelectValue
                                    placeholder={projectsQuery.isPending
                                        ? "Loading projects…"
                                        : "Choose a project"}
                                />
                            </SelectTrigger>
                            <SelectContent>
                                {#each projects as project (project.id)}
                                    <SelectItem
                                        value={project.id}
                                        label={project.name}
                                    />
                                {/each}
                            </SelectContent>
                        </Select>
                    {/if}
                </Field>
            </form>
        </DialogPanel>
        <DialogFooter>
            <Button
                variant="outline"
                onclick={() => void deploy.set(null)}
            >
                Cancel
            </Button>
            <Button
                type="submit"
                form="deploy-template-form"
                disabled={!projectId}
            >
                Continue
            </Button>
        </DialogFooter>
    </DialogContent>
</Dialog>
