using './main.bicep'

param location = 'eastus'
param resourceGroupName = 'rg-daes-observability'
param environment = 'test'
param workspaceName = 'log-daes-observability'
param applicationInsightsName = 'appi-daes-observability'
param retentionInDays = 90
param totalRetentionInDays = 550
param archiveRetentionInDays = 2557
param alertEmail = ''
param deployRoleAssignments = false
param eventPublisherPrincipalIds = [
  '673698ab-0213-4c75-8cf3-d8fb65fc9a2e' // UDAP AI Assistant
  '1d41956c-5698-429a-a07e-7435fcccdd03' // EEOC AI Workspace
]
param tags = {
  system: 'daes'
  owner: 'samasara'
}
