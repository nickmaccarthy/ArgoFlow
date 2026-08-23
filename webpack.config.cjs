const path = require('node:path');
const webpack = require('webpack');
const pkg = require('./package.json');

module.exports = {
  entry: './src/index.tsx',
  output: {
    clean: true,
    filename: 'extension-workflows.js',
    path: path.resolve(__dirname, 'dist')
  },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        exclude: /node_modules/,
        use: {loader: 'ts-loader', options: {transpileOnly: true}}
      }
    ]
  },
  plugins: [
    // Single source of truth: telemetry always reports the released package version.
    new webpack.DefinePlugin({__ARGOFLOW_VERSION__: JSON.stringify(pkg.version)})
  ],
  resolve: {extensions: ['.tsx', '.ts', '.js']},
  externals: {react: 'React'}
};
