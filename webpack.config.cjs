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
    // Telemetry always reports the released version: release builds inject the
    // semantic-release-computed version via ARGOFLOW_VERSION (see
    // scripts/compute-next-version.mjs); local and PR builds fall back to the
    // checked-in package.json value.
    new webpack.DefinePlugin({__ARGOFLOW_VERSION__: JSON.stringify(process.env.ARGOFLOW_VERSION || pkg.version)})
  ],
  resolve: {extensions: ['.tsx', '.ts', '.js']},
  externals: {react: 'React'}
};
