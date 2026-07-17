module.exports = [
  {
    ignores: ['eslint.config.cjs', 'src/**/*.js', 'test/**/*.js', 'bin/**/*.js']
  },
  ...require('@railgun-reloaded/eslint-config')(),
  {
    rules: {
      'jsdoc/require-description': 'off',
      'jsdoc/require-jsdoc': 'off',
      'jsdoc/require-param-description': 'off',
      'jsdoc/require-returns': 'off',
      'jsdoc/require-yields': 'off'
    }
  }
]
