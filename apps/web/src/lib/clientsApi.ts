import { clientResponseSchema, clientsResponseSchema, type Client } from '@moodboard/shared'
import { jsonBody, requestJson } from './http'

export async function listClients(): Promise<Client[]> {
  return clientsResponseSchema.parse(await requestJson('/api/clients')).clients
}

export async function createClient(name: string): Promise<Client> {
  const body = await requestJson('/api/clients', { method: 'POST', body: jsonBody({ name }) })
  return clientResponseSchema.parse(body).client
}

export async function renameClient(id: string, name: string): Promise<Client> {
  const body = await requestJson(`/api/clients/${id}`, {
    method: 'PATCH',
    body: jsonBody({ name }),
  })
  return clientResponseSchema.parse(body).client
}

export async function deleteClient(id: string): Promise<void> {
  await requestJson(`/api/clients/${id}`, { method: 'DELETE' })
}
