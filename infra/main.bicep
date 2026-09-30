targetScope = 'subscription'

@description('Azure region for the observability resources.')
param location string = 'eastus'

@description('Resource group that owns the shared DAES observability resources.')
param resourceGroupName string = 'rg-daes-observability'

@allowed([
  'dev'
  'test'
  'prod'
])
@description('Deployment environment recorded on every managed resource.')
param environment string = 'test'

@description('Existing or new Log Analytics workspace name.')
param workspaceName string = 'log-daes-observability'

@description('Existing or new workspace-based Application Insights name.')
param applicationInsightsName string = 'appi-daes-observability'

@minValue(30)
@maxValue(730)
@description('Interactive retention for Log Analytics tables.')
param retentionInDays int = 90

@minValue(30)
@maxValue(4383)
@description('Total retention for custom workflow and healer tables.')
param totalRetentionInDays int = 550

@minValue(1)
@maxValue(2557)
@description('Retention period for immutable AI question archives.')
param archiveRetentionInDays int = 2557

@description('Optional operations mailbox. Empty disables scheduled-query alert resources.')
param alertEmail string = ''

@description('Create Azure role assignments. Requires Owner or User Access Administrator.')
param deployRoleAssignments bool = false

@description('Managed identity principal IDs allowed to publish shared application events.')
param eventPublisherPrincipalIds array = []

@description('Additional resource tags.')
param tags object = {}

var commonTags = union(tags, {
  application: 'samasara'
  environment: environment
  managedBy: 'bicep'
})

resource observabilityResourceGroup 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: resourceGroupName
  location: location
  tags: commonTags
}

module observability 'observability.bicep' = {
  name: 'samasara-observability-${environment}'
  scope: observabilityResourceGroup
  params: {
    location: location
    environment: environment
    workspaceName: workspaceName
    applicationInsightsName: applicationInsightsName
    retentionInDays: retentionInDays
    totalRetentionInDays: totalRetentionInDays
    archiveRetentionInDays: archiveRetentionInDays
    alertEmail: alertEmail
    deployRoleAssignments: deployRoleAssignments
    eventPublisherPrincipalIds: eventPublisherPrincipalIds
    tags: commonTags
  }
}

output resourceGroupName string = observabilityResourceGroup.name
output workspaceResourceId string = observability.outputs.workspaceResourceId
output workspaceCustomerId string = observability.outputs.workspaceCustomerId
output applicationInsightsResourceId string = observability.outputs.applicationInsightsResourceId
output applicationInsightsConnectionString string = observability.outputs.applicationInsightsConnectionString
output dataCollectionRuleResourceId string = observability.outputs.dataCollectionRuleResourceId
output dataCollectionRuleImmutableId string = observability.outputs.dataCollectionRuleImmutableId
output logsIngestionEndpoint string = observability.outputs.logsIngestionEndpoint
output runtimeIdentityResourceId string = observability.outputs.runtimeIdentityResourceId
output runtimeIdentityClientId string = observability.outputs.runtimeIdentityClientId
output keyVaultName string = observability.outputs.keyVaultName
output archiveStorageAccountName string = observability.outputs.archiveStorageAccountName
