import {
  designRunResponseSchema,
  postDesignToLinearResponseSchema,
  type DesignRun,
} from '@moodboard/shared'
import { jsonBody, requestJson } from './http'

// The designer's runs, as the sidebar's option cards use them.

export async function getDesignRun(id: string): Promise<DesignRun> {
  return designRunResponseSchema.parse(await requestJson(`/api/design-runs/${id}`)).run
}

export async function chooseDesignVariant(runId: string, outputId: string): Promise<DesignRun> {
  const body = await requestJson(`/api/design-runs/${runId}/choose`, {
    method: 'POST',
    body: jsonBody({ outputId }),
  })
  return designRunResponseSchema.parse(body).run
}

export async function postDesignToLinear(runId: string) {
  const body = await requestJson(`/api/design-runs/${runId}/linear-comment`, {
    method: 'POST',
    body: '{}',
  })
  return postDesignToLinearResponseSchema.parse(body)
}
