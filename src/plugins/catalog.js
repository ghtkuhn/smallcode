'use strict';

function buildExtensionCatalog(pluginLoader, skillManager) {
  const plugins = pluginLoader ? pluginLoader.list().map(p => ({ type: 'plugin', ...p })) : [];
  const skills = skillManager ? skillManager.list().map(s => ({ type: 'skill', ...s })) : [];
  const errors = pluginLoader ? pluginLoader.getErrors().map(error => ({ type: 'error', ...error })) : [];
  return {
    plugins,
    skills,
    errors,
    summary: `${plugins.length} plugins · ${skills.length} skills · ${errors.length} warning${errors.length === 1 ? '' : 's'}`,
  };
}

module.exports = { buildExtensionCatalog };
